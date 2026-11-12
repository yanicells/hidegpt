import type { SDKResultMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import type { Block } from '../shared/model'
import { assistantFrame, resultFrame, streamEvent } from './FakeClaude'
import { blocksFromSessionMessages, emptyStreamState, readMessage, resultError } from './mapping'

const assistant = (uuid: string, message: unknown): SessionMessage => ({
  type: 'assistant',
  uuid,
  session_id: 's',
  parent_tool_use_id: null,
  parent_agent_id: null,
  message,
})

describe('blocksFromSessionMessages', () => {
  it('keeps a block whose other fields have unexpected types, and skips only blocks without a type', () => {
    const blocks = blocksFromSessionMessages([
      assistant('a1', {
        id: 7,
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: 'not an object' },
          { text: 'no type, so not a block' },
          { type: 'text', text: 'Week 3 covers attention.', citations: 'unexpected' },
        ],
      }),
    ])
    expect(blocks).toEqual([
      { kind: 'callout', id: 'toolu_1', title: 'Running a command', body: '' },
      // A non-string message id falls back to the transcript uuid.
      { kind: 'agent', id: 'a1', text: 'Week 3 covers attention.' },
    ])
  })
})

const user = (uuid: string, message: unknown): SessionMessage => ({
  type: 'user',
  uuid,
  session_id: 's',
  parent_tool_use_id: null,
  parent_agent_id: null,
  message,
})

describe('blocksFromSessionMessages with Claude Code notices', () => {
  it('reopens a transcript without the notices Claude Code wrote as assistant messages', () => {
    const blocks = blocksFromSessionMessages([
      assistant('a1', {
        id: 'msg_1',
        model: 'claude-x',
        content: [{ type: 'text', text: 'Week 3 covers attention.' }],
      }),
      assistant('a2', {
        id: 'msg_2',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Please run /login · API Error: 401' }],
      }),
    ])
    expect(blocks).toEqual([{ kind: 'agent', id: 'msg_1', text: 'Week 3 covers attention.' }])
  })
})

describe('tool callouts', () => {
  // [tool, input, running title, finished title, body]
  const shown: ReadonlyArray<readonly [string, Record<string, unknown>, string, string, string]> = [
    ['Bash', { command: 'git status' }, 'Running a command', 'Ran a command', 'git status'],
    ['Edit', { file_path: '/n/a.md' }, 'Editing a file', 'Edited a file', '/n/a.md'],
    ['MultiEdit', { file_path: '/n/a.md' }, 'Editing a file', 'Edited a file', '/n/a.md'],
    ['Write', { file_path: '/n/b.md' }, 'Editing a file', 'Edited a file', '/n/b.md'],
    ['NotebookEdit', { notebook_path: '/n/c.ipynb' }, 'Editing a file', 'Edited a file', '/n/c.ipynb'],
    ['Read', { file_path: '/n/a.md' }, 'Opening a file', 'Opened a file', '/n/a.md'],
    ['Glob', { pattern: '**/*.md' }, 'Searching files', 'Searched files', '**/*.md'],
    ['Grep', { pattern: 'attention' }, 'Searching files', 'Searched files', 'attention'],
    ['LS', { path: '/n' }, 'Searching files', 'Searched files', '/n'],
    ['WebSearch', { query: 'week 3' }, 'Looking something up', 'Looked something up', 'week 3'],
    ['WebFetch', { url: 'https://x.test', prompt: 'Summarize' }, 'Opening a link', 'Opened a link', 'https://x.test'],
    [
      'Agent',
      { subagent_type: 'general-purpose', description: 'Find readings', prompt: 'Search the repo' },
      'Background task',
      'Background task',
      'Find readings',
    ],
    ['Task', { prompt: 'Search the repo' }, 'Background task', 'Background task', ''],
    [
      'mcp__claude_ai_Notion__notion-search',
      { query: 'notes', filters: { a: 1 } },
      'Notion · notion search',
      'Notion · notion search',
      'notes',
    ],
    ['mcp__claude__claude_search', { query: 'notes' }, 'A connected app · search', 'A connected app · search', 'notes'],
    ['SomeNewTool', { flag: true, nested: { a: 1 } }, 'Doing a step', 'Did a step', ''],
  ]
  const hidden = ['TodoWrite', 'TaskStop', 'ToolSearch', 'SendMessage', 'Monitor', 'AskUserQuestion', 'ExitPlanMode']

  const transcript = (tools: ReadonlyArray<readonly [string, Record<string, unknown>]>, finished: boolean) =>
    blocksFromSessionMessages([
      assistant('a1', {
        id: 'msg_1',
        content: tools.map(([name, input], index) => ({ type: 'tool_use', id: `toolu_${index}`, name, input })),
      }),
      ...(finished
        ? [
            user('u1', {
              content: tools.map((_, index) => ({ type: 'tool_result', tool_use_id: `toolu_${index}`, content: '' })),
            }),
          ]
        : []),
    ])

  it('titles each step by kind and shows one input field, never JSON or a subagent brief', () => {
    const tools = shown.map(([name, input]) => [name, input] as const)
    const view = (blocks: Block[]) => blocks.map((block) => (block.kind === 'callout' ? [block.title, block.body] : []))
    expect(view(transcript(tools, false))).toEqual(shown.map(([, , running, , body]) => [running, body]))
    expect(view(transcript(tools, true))).toEqual(shown.map(([, , , done, body]) => [done, body]))
    for (const block of transcript(tools, true)) {
      if (block.kind === 'callout')
        expect(`${block.title}\n${block.body}`).not.toMatch(/claude|anthropic|mcp__|subagent|[{"]/i)
    }
  })

  it('draws no callout for bookkeeping tools, or for the question and plan tools whose card shows them', () => {
    expect(
      transcript(
        hidden.map((name) => [name, { todos: [] }] as const),
        true,
      ),
    ).toEqual([])
  })
})

describe('readMessage with a Claude Code notice', () => {
  it('clears text streamed under its id and classes the turn by its error', () => {
    const state = emptyStreamState()
    readMessage(state, streamEvent({ type: 'message_start', message: { id: 'msg_n' } }))
    readMessage(
      state,
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'API Error' } }),
    )
    const text = [{ type: 'text', text: 'API Error: 529 overloaded' }]
    const synthetic = {
      ...assistantFrame('msg_n', text),
      message: { id: 'msg_n', role: 'assistant', model: '<synthetic>', content: text },
      error: 'overloaded',
    } as never
    expect(readMessage(state, synthetic)).toEqual([{ type: 'block', block: { kind: 'agent', id: 'msg_n', text: '' } }])
    expect(readMessage(state, resultFrame({ is_error: true, result: 'API Error: 529 overloaded' }))).toEqual([
      { type: 'result', failure: { kind: 'provider_error', detail: 'API Error: 529 overloaded' } },
    ])
  })
})

const result = (fields: Partial<SDKResultMessage>): SDKResultMessage =>
  ({ type: 'result', subtype: 'success', is_error: true, result: '', terminal_reason: undefined, ...fields }) as never

describe('resultError', () => {
  it('classes a failed turn and keeps the provider text only as detail, without diagnostics', () => {
    expect(resultError(result({ result: 'API Error: 429\n[ede_diagnostic] x' }), 'rate_limit')).toEqual({
      kind: 'usage_limit',
      detail: 'API Error: 429',
    })
    const kinds = [
      resultError(result({ api_error_status: 429 })),
      resultError(result({}), 'authentication_failed'),
      resultError(result({ api_error_status: 403 })),
      resultError(result({ api_error_status: 529 })),
      resultError(result({}), 'overloaded'),
      resultError(result({}), 'invalid_request'),
      resultError(result({ terminal_reason: 'prompt_too_long' })),
      resultError(result({ terminal_reason: 'blocking_limit' })),
      resultError(result({ subtype: 'error_max_budget_usd', errors: [] } as never)),
      resultError(result({ subtype: 'error_max_turns', errors: [] } as never)),
    ].map((failure) => failure?.kind)
    expect(kinds).toEqual([
      'usage_limit',
      'auth',
      'auth',
      'provider_error',
      'provider_error',
      'validation_error',
      'validation_error',
      'validation_error',
      'usage_limit',
      'unknown',
    ])
  })

  it('reports nothing for a finished or stopped turn', () => {
    expect(resultError(result({ is_error: false }))).toBeUndefined()
    expect(resultError(result({ terminal_reason: 'aborted_streaming' }))).toBeUndefined()
    expect(
      resultError(result({ subtype: 'error_during_execution', errors: ['Request interrupted'] } as never)),
    ).toBeUndefined()
  })
})
