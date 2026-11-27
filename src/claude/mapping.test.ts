import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import { blocksFromSessionMessages, sessionTitle, toDoc } from './mapping'

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

describe('document titles', () => {
  const prompt = 'Write a 500-word essay on photosynthesis'
  const info = (fields: Partial<SDKSessionInfo>): SDKSessionInfo => ({
    sessionId: 's',
    summary: prompt,
    firstPrompt: prompt,
    lastModified: 0,
    ...fields,
  })

  it('reads "Untitled document" while the summary is only the first prompt; Home still lists the prompt', () => {
    expect(sessionTitle(info({}))).toBe('Untitled document')
    expect(toDoc(info({}))).toMatchObject({ name: null, preview: prompt })
  })

  it('takes the custom title (a /rename, or a title Claude wrote)', () => {
    expect(sessionTitle(info({ customTitle: 'Bio essay', summary: 'Bio essay' }))).toBe('Bio essay')
    expect(toDoc(info({ customTitle: 'Bio essay' })).name).toBe('Bio essay')
  })

  it('never names a document after a later prompt, which the SDK reports as its summary', () => {
    const later = info({ summary: 'Now make it shorter and add sources' })
    expect(sessionTitle(later)).toBe('Untitled document')
    expect(toDoc(later)).toMatchObject({ name: null, preview: prompt })
  })
})
