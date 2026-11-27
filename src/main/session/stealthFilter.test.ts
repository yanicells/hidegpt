import { describe, expect, it } from 'vitest'

import {
  BinaryMissingError,
  ProcessExitedError,
  ProviderNotReadyError,
  ProviderTimeoutError,
} from '../../provider/errors'
import { emptySnapshot, type ApprovalBlock, type Block, type Snapshot } from '../../shared/model'
import { diffSnapshot, isEmptyPatch } from '../../shared/snapshot-patch'
import { stealthViolations } from '../../shared/stealth'
import { calloutTitle, filterSnapshot, neutralizeError } from './stealthFilter'

/**
 * Every tool-row title the adapters write, here and on `32-combined`
 * (`src/codex/mapping.ts` itemToBlock, `src/claude/mapping.ts` toolTitle,
 * `src/opencode/mapping.ts` toolCallout, `present.ts`), with each template
 * filled in, plus names a connected app or skill could bring.
 */
const CALLOUT_TITLES = [
  // Codex
  'Ran a command',
  'Running a command',
  '1 file change',
  '3 file changes',
  'Using a connected app',
  'Used a connected app',
  'A connected app didn’t respond',
  'github · search_issues',
  'claude_ai_Notion · search',
  'Notion · get_tokens',
  'model-context · fetch',
  'prompt-library · list',
  'Looked something up',
  'Image',
  'Generated image',
  'Subtask · spawn_agent',
  'Compacted context',
  'Review',
  'Left review',
  'Finished a step',
  'Changes',
  // Claude: Bash has its own title, every other tool is "Using X" then "Used X".
  ...[
    'Read',
    'Edit',
    'Write',
    'MultiEdit',
    'Grep',
    'Glob',
    'WebSearch',
    'WebFetch',
    'Task',
    'Agent',
    'TodoWrite',
  ].flatMap((tool) => [`Using ${tool}`, `Used ${tool}`]),
  'Using a tool',
  'Used mcp__claude_ai_Notion__notion-search',
  'Used mcp__openai-docs__fetch',
  'Used mcp__agent-tools__list_models',
  'Used mcp__slack-bot__post',
  'Used mcp__x__ask_llm',
  'Used SomeNewTool',
  // OpenCode
  ...['bash', 'read', 'edit', 'write', 'grep', 'glob', 'webfetch', 'task', 'todowrite', 'codex_helper'].map(
    (tool) => `Ran ${tool}`,
  ),
]

/**
 * Every request title and fixed body, here and on `32-combined` (codex
 * APPROVALS, claude permissionBlock/questionBlock, opencode
 * permissionBlock/questionBlock, `present.ts` REQUESTS).
 */
const APPROVALS: ReadonlyArray<Pick<ApprovalBlock, 'title' | 'body'>> = [
  // Codex
  { title: 'Run command?', body: 'git status' },
  { title: 'Apply file changes?', body: 'Files in this folder will change.' },
  { title: 'Edit files?', body: 'Some files will change.' },
  { title: 'Grant extra access?', body: 'More access is needed to continue.' },
  { title: 'Allow more access?', body: 'More access is needed to continue.' },
  { title: 'Continue with claude-in-chrome?', body: 'Open the page?' },
  { title: 'Continue with slack-bot?', body: 'Post the message?' },
  { title: 'Allow slack-bot?', body: 'Post the message?' },
  { title: 'Allow claude_ai_Notion?', body: 'Search your pages?' },
  { title: 'Waiting for your response', body: 'Which file?' },
  // Claude
  { title: 'Allow Bash?', body: 'ls' },
  { title: 'Allow Read?', body: '/tmp/a.md' },
  { title: 'Allow WebFetch?', body: 'https://example.com' },
  { title: 'Allow search issues?', body: '' },
  { title: 'Allow mcp__agent-tools__list_models?', body: '' },
  { title: 'Allow this tool?', body: '' },
  { title: 'Claude needs input', body: 'Pick one' },
  // OpenCode
  { title: 'Allow bash: git push?', body: 'More access is needed to continue.' },
  { title: 'Allow external_directory: /etc/*?', body: 'The assistant is asking for extra access.' },
  { title: 'Allow edit?', body: 'More access is needed to continue.' },
  { title: 'The assistant needs input', body: 'Continue?' },
  // present.ts
  { title: 'Allow this step?', body: '' },
  { title: 'Fill in these details?', body: '' },
]

/** Every error sentence that can reach `snapshot.error` or a command's reply today. */
const ERRORS = [
  // src/provider/errors.ts, for each provider
  ...(['codex', 'opencode', 'claude'] as const).flatMap((provider) => [
    new ProviderTimeoutError({ provider, operation: 'thread/start', seconds: 20 }).message,
    new ProcessExitedError({ provider, code: 1, signal: null, stderr: 'codex: panic' }).message,
    new BinaryMissingError({ provider, command: provider }).message,
    new ProviderNotReadyError({ provider, detail: null }).message,
  ]),
  // src/main/ProviderRegistry.ts, ProviderSessionManager.ts
  'Docs could not load Claude. Docs saved a report.',
  'OpenCode signs in outside Docs — run `opencode auth login` in a terminal, then Refresh.',
  'Claude signs in outside Docs — run `claude` in a terminal and log in, then Tools → Refresh.',
  // src/codex
  'This document is open in ChatGPT or another window. Close it there, then open it here.',
  'Codex sent an unexpected reply to thread/start.',
  'Sign in with ChatGPT to refresh this session.',
  // src/claude
  'Claude signs in outside Docs. Run `claude` in a terminal and log in, then use Tools → Refresh.',
  'Claude Code could not do that.',
  'Claude Code stopped before it finished (exit 1). Send your message again to continue.',
  'Claude could not find that document.',
  'Claude is still answering. Wait for it, or stop it first.',
  'Claude Code stopped. Send your message again to continue.',
  'Claude stopped after reaching its step limit.',
  'Claude stopped after reaching its spending limit.',
  'Claude could not finish the answer.',
  'Claude ran into an error.',
  'Claude stopped before finishing.',
  // src/opencode
  'OpenCode has no model providers set up. Run `opencode auth login` in a terminal, then use Tools → Refresh.',
  'OpenCode did not accept that request.',
  'OpenCode could not find that document.',
  'OpenCode is not responding.',
  'OpenCode could not do that.',
  'Pick a model first.',
  'OpenCode did not take that answer. Try again.',
  'The assistant ran into an error.',
  'The model provider failed the request (HTTP 500).',
  'The model provider failed the request and did not include an error message.',
]

const callout = (id: string, title: string, body = ''): Block => ({ kind: 'callout', id, title, body })
const approval = (id: string, title: string, body: string): ApprovalBlock => ({
  kind: 'approval',
  id,
  suggestion: 'add',
  title,
  body,
  fields: [],
  questions: [],
  resolved: null,
})

const doc = (blocks: ReadonlyArray<Block>, extra: Partial<Snapshot> = {}): Snapshot => ({
  ...emptySnapshot(),
  route: { kind: 'doc', threadId: 't' },
  title: 'Notes',
  blocks,
  ...extra,
})

describe('filterSnapshot', () => {
  it('leaves no banned word in any title, body or error the adapters write today', () => {
    const blocks = [
      ...CALLOUT_TITLES.map((title, index) => callout(`c${index}`, title)),
      ...APPROVALS.map(({ title, body }, index) => approval(`a${index}`, title, body)),
    ]
    const out = filterSnapshot(doc(blocks)).blocks
    for (const block of out) {
      if (block.kind === 'callout') expect(stealthViolations(block.title), block.title).toEqual([])
      if (block.kind === 'approval') expect(stealthViolations(`${block.title} ${block.body}`)).toEqual([])
    }
    for (const error of ERRORS) {
      expect(stealthViolations(filterSnapshot(doc([], { error })).error!), error).toEqual([])
      expect(stealthViolations(neutralizeError(error)), error).toEqual([])
    }
  })

  it('uses the agreed Docs wording for known titles', () => {
    expect(calloutTitle('Used Read')).toBe('Opened a file')
    expect(calloutTitle('Ran bash')).toBe('Ran a command')
    expect(calloutTitle('Subtask · spawn_agent')).toBe('Background task')
    expect(calloutTitle('Compacted context')).toBe('Earlier content summarized')
    expect(calloutTitle('Used mcp__claude_ai_Notion__notion-search')).toBe('Notion · Notion Search')
    expect(calloutTitle('Used mcp__agent-tools__list_models')).toBe('Tools · List')
    expect(calloutTitle('Used mcp__x__ask_llm')).toBe('X · Ask')
    expect(calloutTitle('Used SomeNewTool')).toBe('Did a step')
    // New neutral wording passes through, so adapters can move to it without this filter undoing it.
    expect(calloutTitle('Opened a file')).toBe('Opened a file')

    const titles = filterSnapshot(
      doc([
        approval('a', 'Edit files?', 'Some files will change.'),
        approval('b', 'Allow more access?', 'More access is needed to continue.'),
        approval('c', 'Allow bash: git push?', 'More access is needed to continue.'),
        approval('d', 'Allow Notion?', 'Search your pages?'),
        approval('e', 'Allow claude_ai_Notion?', 'Search your pages?'),
        approval('f', 'Allow search issues?', ''),
        approval('g', 'Allow mcp__x__ask_llm?', ''),
        approval('h', 'Allow external_directory: /etc/*?', 'The assistant is asking for extra access.'),
      ]),
    ).blocks.map((block) => (block.kind === 'approval' ? [block.title, block.body] : []))
    expect(titles).toEqual([
      ['Suggested edit', 'Some files will change.'],
      ['Access request', 'More access is needed to continue.'],
      ['Run this command?', 'git push'],
      // A connected app keeps its name; only a name with a vendor in it changes.
      ['Allow Notion?', 'Search your pages?'],
      ['Allow Notion?', 'Search your pages?'],
      ['Allow search issues?', ''],
      ['Allow this step?', ''],
      ['Allow this step?', '/etc/*'],
    ])
    expect(neutralizeError('Codex did not answer in 20 s. Try again, or use Tools → Refresh.')).toBe(
      'Docs is taking longer than usual. Try again, or use Tools → Refresh.',
    )
  })

  it('never alters content: answers, the person’s text, callout bodies, commands and questions', () => {
    const blocks: Block[] = [
      { kind: 'user', id: 'u', text: 'Ask Claude which model is best' },
      { kind: 'agent', id: 'g', text: 'Claude is a model by Anthropic.' },
      callout('c', 'Ran a command', 'codex exec --model gpt-5'),
      { ...approval('a', 'Run command?', 'claude --version'), questions: [] },
      {
        ...approval('q', 'Claude needs input', 'Use the Claude model?'),
        questions: [{ id: 'q0', question: 'Use the Claude model?', options: ['Claude', 'GPT'], allowText: true }],
      },
    ]
    const out = filterSnapshot(doc(blocks)).blocks
    expect(out.slice(0, 3)).toEqual(blocks.slice(0, 3))
    expect(out[3]).toEqual({ ...blocks[3], title: 'Suggested command' })
    expect(out[4]).toEqual({ ...blocks[4], title: 'Needs your reply' })
  })

  it('removes vendor words from the document title only', () => {
    // Titles providers really give (ARCH-2's title_stealth scenario), and clean ones that must not change.
    expect(filterSnapshot(doc([], { title: 'Claude Code session' })).title).toBe('session')
    expect(filterSnapshot(doc([], { title: 'Ask GPT about photosynthesis' })).title).toBe('Ask about photosynthesis')
    expect(filterSnapshot(doc([], { title: 'Codex notes on the model' })).title).toBe('notes on the model')
    expect(filterSnapshot(doc([], { title: 'Claude' })).title).toBe('Untitled document')
    for (const title of ['Claude Code session', 'Ask GPT about photosynthesis']) {
      expect(stealthViolations(filterSnapshot(doc([], { title })).title)).toEqual([])
    }
    for (const title of ['Week 3 reading notes', 'Essay on AI ethics']) {
      const clean = doc([], { title })
      expect(filterSnapshot(clean).title).toBe(title)
      expect(filterSnapshot(clean)).toBe(clean)
    }
  })

  it('removes vendor words from the titles on Home, keeping the list when none needs it', () => {
    const thread = (id: string, name: string | null) => ({
      id,
      name,
      preview: 'Claude Code session',
      updatedAt: 0,
      cwd: '/tmp',
      projectId: null,
    })
    const threads = [thread('a', 'Claude Code session'), thread('b', 'Week 3 reading notes'), thread('c', 'Codex')]
    const out = filterSnapshot({ ...emptySnapshot(), threads })
    expect(out.threads.map((doc) => doc.name)).toEqual(['session', 'Week 3 reading notes', 'Untitled document'])
    expect(out.threads[1]).toBe(threads[1])
    // The same list gives the same filtered list, so an unrelated publish sends no thread patch.
    expect(filterSnapshot({ ...emptySnapshot(), threads }).threads).toBe(out.threads)

    const clean = { ...emptySnapshot(), threads: [thread('b', 'Week 3 reading notes'), thread('d', null)] }
    expect(filterSnapshot(clean)).toBe(clean)
  })

  it('keeps identity, so an unchanged publish is an empty patch', () => {
    const clean = doc([{ kind: 'agent', id: 'g', text: 'hi' }, callout('c', 'Ran a command')])
    expect(filterSnapshot(clean)).toBe(clean)

    const blocks = [{ kind: 'agent', id: 'g', text: 'hi' } as Block, callout('c', 'Used Read', 'a.md')]
    const raw = doc(blocks, { error: 'Claude ran into an error.' })
    const first = filterSnapshot(raw)
    // A new snapshot object around the same values, as main makes it for an unrelated change.
    const again = filterSnapshot({ ...raw })
    expect(again.blocks).toBe(first.blocks)
    expect(isEmptyPatch(diffSnapshot(first, again))).toBe(true)

    // Streaming: only the growing answer changes; the filtered tool row keeps its object.
    const grown = filterSnapshot({ ...raw, blocks: [{ kind: 'agent', id: 'g', text: 'hi there' }, blocks[1]!] })
    expect(grown.blocks[1]).toBe(first.blocks[1])
    expect(diffSnapshot(first, grown).blocks).toEqual({ length: 2, append: [[0, ' there']] })
  })
})
