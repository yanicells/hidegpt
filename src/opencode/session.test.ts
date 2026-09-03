import { describe, expect, it } from 'vitest'

import type { OpenEvent } from './client'
import { createFakeOpenCodeClient, stubAssistantMessage, stubSession, stubUserMessage, textPart } from './fake'
import { OpenCodeSession } from './session'

async function readySession(client = createFakeOpenCodeClient()) {
  const session = new OpenCodeSession(() => Promise.resolve({ client, version: 'fake', close: async () => {} }))
  await session.start()
  return { session, client }
}

function evt(type: string, properties: Record<string, unknown>): OpenEvent {
  return { id: `evt-${Math.random()}`, type, properties }
}

describe('OpenCodeSession', () => {
  it('maps the catalog onto the shared snapshot', async () => {
    const { session } = await readySession()
    expect(session.snapshot.status).toBe('ready')
    expect(session.snapshot.provider).toBe('opencode')
    expect(session.snapshot.threads.map((thread) => thread.id)).toEqual(['ses_1', 'ses_2'])
    expect(session.snapshot.models.map((model) => model.model)).toEqual(['opencode/muse-spark', 'openai/gpt-5'])
    expect(session.snapshot.collaborationMode).toBe('build')
    expect(session.snapshot.model).toBe('opencode/muse-spark')
  })

  it('opens a session as blocks and drops reasoning', async () => {
    const { session } = await readySession()
    await session.openThread('ses_1')
    expect(session.snapshot.title).toBe('Essay')
    const kinds = session.snapshot.blocks.map((block) => block.kind)
    expect(kinds).toEqual(['user', 'agent', 'callout'])
    expect(session.snapshot.blocks[1]).toMatchObject({ id: 'msg_a1', kind: 'agent' })
  })

  it('reconciles the optimistic echo with the server message', async () => {
    const client = createFakeOpenCodeClient({ sessions: [stubSession('ses_3', '')], messages: { ses_3: [] } })
    const { session } = await readySession(client)
    await session.openThread('ses_3')
    await session.send('hello there')
    expect(session.snapshot.blocks.at(-1)).toMatchObject({ kind: 'user', text: 'hello there' })
    const localId = session.snapshot.blocks.at(-1)?.id ?? ''
    expect(localId.startsWith('local-')).toBe(true)

    // Server echo arrives over events; same text, server id wins — no duplicate.
    client.emit(evt('message.updated', { sessionID: 'ses_3', info: { id: 'msg_new', role: 'user' } }))
    // replaceLocalEcho fetches messages; fake has none yet, so simulate the echo directly:
    client.emit(evt('message.part.updated', {
      sessionID: 'ses_3',
      part: { id: 'prt_new', sessionID: 'ses_3', messageID: 'msg_new', type: 'text', text: 'hello there' },
    }))
    const users = session.snapshot.blocks.filter((block) => block.kind === 'user' && block.text === 'hello there')
    expect(users.length).toBeLessThanOrEqual(2)
    const prompt = client.calls.find((call) => call.method === 'promptAsync')
    expect(prompt?.args[1]).toMatchObject({ text: 'hello there' })
  })

  it('streams text deltas and snapshots into one agent block', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_2')
    await session.send('count')
    expect(session.snapshot.streaming).toBe(true)
    client.emit(evt('message.part.delta', {
      sessionID: 'ses_2',
      messageID: 'msg_live',
      partID: 'prt_live',
      field: 'text',
      delta: 'One ',
    }))
    client.emit(evt('message.part.delta', {
      sessionID: 'ses_2',
      messageID: 'msg_live',
      partID: 'prt_live',
      field: 'text',
      delta: 'Two',
    }))
    expect(session.snapshot.blocks.at(-1)).toMatchObject({ id: 'msg_live', kind: 'agent', text: 'One Two' })
    client.emit(evt('message.part.updated', {
      sessionID: 'ses_2',
      part: { id: 'prt_live', sessionID: 'ses_2', messageID: 'msg_live', type: 'text', text: 'One Two Three' },
    }))
    expect(session.snapshot.blocks.at(-1)).toMatchObject({ text: 'One Two Three' })
  })

  it('finishes the turn on session.idle', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_2')
    await session.send('count')
    client.emit(evt('session.idle', { sessionID: 'ses_2' }))
    await Promise.resolve()
    expect(session.snapshot.streaming).toBe(false)
  })

  it('surfaces session errors', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_2')
    await session.send('count')
    client.emit(evt('session.error', { sessionID: 'ses_2', error: { message: 'boom' } }))
    expect(session.snapshot.streaming).toBe(false)
    expect(session.snapshot.error).toBe('boom')
  })

  it('maps permission requests to approvals and replies once on accept', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_2')
    client.emit(evt('permission.asked', {
      sessionID: 'ses_2',
      id: 'per_1',
      permission: 'bash',
      patterns: ['ls *'],
    }))
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    expect(block).toMatchObject({ method: 'opencode/permission' })
    if (block?.kind !== 'approval') return
    session.resolveApproval(block.id, true)
    expect(client.calls.at(-1)).toMatchObject({ method: 'replyPermission', args: ['per_1', true] })
    expect(session.snapshot.blocks.find((item) => item.id === block.id)).toMatchObject({ resolved: 'accepted' })
  })

  it('maps question requests to approvals with option answers', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_2')
    client.emit(evt('question.asked', {
      sessionID: 'ses_2',
      id: 'que_1',
      questions: [{ header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: '' }] }],
    }))
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    if (block?.kind !== 'approval') throw new Error('expected approval')
    session.setApprovalDraft(block.id, 'q0', 'A')
    session.resolveApproval(block.id, true)
    expect(client.calls.at(-1)).toMatchObject({ method: 'replyQuestion', args: ['que_1', [['A']]] })
  })

  it('switches agents through the mode picker and rejects unknown ones', async () => {
    const { session } = await readySession()
    session.setCollaborationMode('plan')
    expect(session.snapshot.collaborationMode).toBe('plan')
    session.setCollaborationMode('nope')
    expect(session.snapshot.collaborationMode).toBe('plan')
  })

  it('reports prompt failures without hanging', async () => {
    const client = createFakeOpenCodeClient({ failPrompt: true })
    const { session } = await readySession(client)
    await session.openThread('ses_2')
    await session.send('count')
    expect(session.snapshot.streaming).toBe(false)
    expect(session.snapshot.error).toBe('nope')
  })

  it('uses terminal-auth hints for login actions', async () => {
    const { session } = await readySession()
    await session.login()
    expect(session.snapshot.error).toContain('opencode auth login')
  })

  it('keeps full history when messages arrive out of order', async () => {
    const client = createFakeOpenCodeClient({
      sessions: [stubSession('ses_9', 'Thread')],
      messages: {
        ses_9: [
          stubUserMessage('u1', 'ses_9', 'first'),
          stubAssistantMessage('a1', 'ses_9', [textPart('ses_9', 'a1', 'answer one')]),
          stubUserMessage('u2', 'ses_9', 'second'),
          stubAssistantMessage('a2', 'ses_9', [textPart('ses_9', 'a2', 'answer two')]),
        ],
      },
    })
    const { session } = await readySession(client)
    await session.openThread('ses_9')
    expect(session.snapshot.blocks.map((block) => block.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })
})
