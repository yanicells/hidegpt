import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'

import { createFakeClaudeSdk } from './fake'
import { ClaudeSession } from './session'

async function readySession(sdk = createFakeClaudeSdk()) {
  const session = new ClaudeSession(sdk)
  await session.start()
  await vi.waitFor(() => expect(session.snapshot.models.length).toBeGreaterThan(0))
  return { session, sdk }
}

const transcript = (messages: Omit<SessionMessage, 'session_id' | 'parent_agent_id'>[]): SessionMessage[] =>
  messages.map((message) => ({ ...message, session_id: 'claude-1', parent_agent_id: null }))

describe('ClaudeSession', () => {
  it('lists saved sessions as documents and offers user skills, not built-ins', async () => {
    const { session } = await readySession()
    expect(session.snapshot.status).toBe('ready')
    expect(session.snapshot.threads.map((thread) => thread.name)).toEqual(['Seminar reading notes', 'Essay feedback'])
    expect(session.snapshot.model).toBe('default')
    expect(session.snapshot.skills.map((skill) => skill.name)).toEqual(['humanizer'])
  })

  it('streams a new document, invoking a skill as /name and titling it after the first turn', async () => {
    const { session, sdk } = await readySession()
    await session.newDocument({ title: 'Lab report', cwd: '/tmp' })
    const id = session.snapshot.route.kind === 'doc' ? session.snapshot.route.threadId : ''
    expect(sdk.started.at(-1)).toMatchObject({ sessionId: id, cwd: '/tmp', includePartialMessages: true })

    await session.send('fix this', { skill: 'humanizer' })
    await vi.waitFor(() =>
      expect(sdk.sent.at(-1)?.message.content).toEqual([{ type: 'text', text: '/humanizer fix this' }]),
    )
    await vi.waitFor(() => expect(session.snapshot.streaming).toBe(false))
    expect(session.snapshot.blocks[0]).toMatchObject({ kind: 'user', text: 'fix this', skills: ['humanizer'] })
    expect(session.snapshot.blocks[1]).toMatchObject({ kind: 'agent', text: 'Here is a reply to: /humanizer fix this' })
    await vi.waitFor(() => expect(sdk.renamed).toEqual([[id, 'Lab report']]))
  })

  it('asks before a tool runs and continues once accepted', async () => {
    const { session } = await readySession()
    await session.newDocument()
    await session.send('run the tests')
    await vi.waitFor(() => expect(session.snapshot.blocks.some((block) => block.kind === 'approval')).toBe(true))
    const approval = session.snapshot.blocks.find((block) => block.kind === 'approval')
    expect(approval).toMatchObject({ title: 'Allow Bash?', body: 'ls', resolved: null })
    session.resolveApproval(approval?.id ?? '', true)
    await vi.waitFor(() => expect(session.snapshot.streaming).toBe(false))
    expect(session.snapshot.blocks.find((block) => block.kind === 'approval')).toMatchObject({ resolved: 'accepted' })
    expect(session.snapshot.blocks.at(-1)).toMatchObject({ kind: 'agent' })
  })

  it('rebuilds a saved transcript without thinking, subagents, or injected skill text', async () => {
    const sdk = createFakeClaudeSdk({
      transcripts: {
        'claude-1': transcript([
          {
            type: 'user',
            uuid: 'u1',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
                { type: 'text', text: '<command-name>/humanizer</command-name><command-args>fix it</command-args>' },
              ],
            },
          },
          {
            type: 'user',
            uuid: 'u2',
            parent_tool_use_id: null,
            message: { role: 'user', content: 'Base directory for this skill: /s\n\nWrite plainly.' },
          },
          {
            type: 'assistant',
            uuid: 'a1',
            parent_tool_use_id: null,
            message: {
              id: 'msg_1',
              content: [
                { type: 'thinking', thinking: 'private' },
                { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
              ],
            },
          },
          {
            type: 'user',
            uuid: 'u3',
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'notes.md' }] },
          },
          {
            type: 'assistant',
            uuid: 'a2',
            parent_tool_use_id: 'tool_9',
            message: { id: 'msg_sub', content: [{ type: 'text', text: 'subagent chatter' }] },
          },
          {
            type: 'assistant',
            uuid: 'a3',
            parent_tool_use_id: null,
            message: { id: 'msg_1', content: [{ type: 'text', text: 'Done.' }] },
          },
        ]),
      },
    })
    const { session } = await readySession(sdk)
    await session.openThread('claude-1')
    expect(session.snapshot.blocks).toEqual([
      { kind: 'user', id: 'u1', text: 'fix it', images: ['data:image/png;base64,AAAA'], skills: ['humanizer'] },
      { kind: 'callout', id: 'tool_1', title: 'Ran a command', body: 'ls\nnotes.md' },
      { kind: 'agent', id: 'msg_1', text: 'Done.' },
    ])
    expect(sdk.started.at(-1)).toMatchObject({ resume: 'claude-1' })
  })
})
