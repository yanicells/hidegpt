import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import { blocksFromSessionMessages } from './mapping'

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

  it('shows a failed tool in Docs’ words, never its error text', () => {
    const blocks = blocksFromSessionMessages([
      assistant('a1', { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls /root' } }] }),
      {
        type: 'user',
        uuid: 'u1',
        session_id: 's',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'ls: /root: Permission denied' },
          ],
        },
      } as SessionMessage,
    ])
    expect(blocks).toEqual([{ kind: 'callout', id: 'toolu_1', title: 'A step didn’t finish', body: 'ls /root' }])
  })
})
