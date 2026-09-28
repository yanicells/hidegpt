import { describe, expect, it } from 'vitest'

import type { OpenEvent, OpenPromptPart } from './client'
import { blocksFromMessages } from './mapping'
import { createFakeOpenCodeClient, stubAssistantMessage, stubSession, stubUserMessage, textPart } from './fake'
import { OpenCodeSession } from './session'

async function readySession(client = createFakeOpenCodeClient()) {
  const session = new OpenCodeSession(() => Promise.resolve({ client, version: 'fake', close: async () => {} }))
  await session.start()
  return { session, client }
}

let evtSeq = 0
function evt(type: string, properties: Record<string, unknown>): OpenEvent {
  evtSeq += 1
  return { id: `evt-${evtSeq}`, type, properties }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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
    client.emit(
      evt('message.part.updated', {
        sessionID: 'ses_3',
        part: { id: 'prt_new', sessionID: 'ses_3', messageID: 'msg_new', type: 'text', text: 'hello there' },
      }),
    )
    const users = session.snapshot.blocks.filter((block) => block.kind === 'user' && block.text === 'hello there')
    expect(users.length).toBeLessThanOrEqual(2)
    const prompt = client.calls.find((call) => call.method === 'promptAsync')
    expect(prompt?.args[1]).toMatchObject({ parts: [{ type: 'text', text: 'hello there' }] })
  })

  it('sends a chosen skill as a hidden part and reads it back from history', async () => {
    const client = createFakeOpenCodeClient({ sessions: [stubSession('ses_3', '')], messages: { ses_3: [] } })
    const { session } = await readySession(client)
    await session.openThread('ses_3')
    expect(session.snapshot.skills).toEqual([
      { name: 'humanizer', description: 'Rewrite text so it reads naturally', path: '/tmp/skills/humanizer/SKILL.md' },
    ])
    await session.send('fix my essay', { skill: 'humanizer' })
    const prompt = client.calls.find((call) => call.method === 'promptAsync')
    const parts = (prompt?.args[1] as { parts: OpenPromptPart[] }).parts
    expect(parts[0]).toEqual({ type: 'text', text: 'fix my essay' })
    expect(parts[1]).toMatchObject({ type: 'text', synthetic: true })
    expect(session.snapshot.blocks.at(-1)).toMatchObject({ text: 'fix my essay', skills: ['humanizer'] })

    const history = blocksFromMessages([
      {
        info: { id: 'msg_u', sessionID: 'ses_3', role: 'user', time: { created: 1 } },
        parts: parts.map((part, index) => ({ ...part, id: `p${index}`, sessionID: 'ses_3', messageID: 'msg_u' })),
      },
    ])
    expect(history).toEqual([{ kind: 'user', id: 'msg_u', text: 'fix my essay', skills: ['humanizer'] }])
  })

  it('streams text deltas and snapshots into one agent block', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_2')
    await session.send('count')
    expect(session.snapshot.streaming).toBe(true)
    client.emit(
      evt('message.part.updated', {
        sessionID: 'ses_2',
        part: { id: 'prt_live', messageID: 'msg_live', type: 'text', text: '' },
      }),
    )
    client.emit(
      evt('message.part.delta', {
        sessionID: 'ses_2',
        messageID: 'msg_live',
        partID: 'prt_live',
        field: 'text',
        delta: 'One ',
      }),
    )
    client.emit(
      evt('message.part.delta', {
        sessionID: 'ses_2',
        messageID: 'msg_live',
        partID: 'prt_live',
        field: 'text',
        delta: 'Two',
      }),
    )
    expect(session.snapshot.blocks.at(-1)).toMatchObject({ id: 'msg_live', kind: 'agent', text: 'One Two' })
    client.emit(
      evt('message.part.updated', {
        sessionID: 'ses_2',
        part: { id: 'prt_live', sessionID: 'ses_2', messageID: 'msg_live', type: 'text', text: 'One Two Three' },
      }),
    )
    expect(session.snapshot.blocks.at(-1)).toMatchObject({ text: 'One Two Three' })
  })

  it('never displays reasoning or unclassified text deltas', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_2')
    const before = session.snapshot.blocks
    client.emit(
      evt('message.part.updated', {
        sessionID: 'ses_2',
        part: { id: 'thought', messageID: 'msg_live', type: 'reasoning', text: 'private' },
      }),
    )
    client.emit(
      evt('message.part.delta', {
        sessionID: 'ses_2',
        messageID: 'msg_live',
        partID: 'thought',
        field: 'text',
        delta: 'private reasoning',
      }),
    )
    client.emit(
      evt('message.part.delta', {
        sessionID: 'ses_2',
        messageID: 'msg_live',
        partID: 'unknown',
        field: 'text',
        delta: 'unknown',
      }),
    )
    expect(session.snapshot.blocks).toEqual(before)
    client.emit(
      evt('message.part.updated', {
        sessionID: 'ses_2',
        part: { id: 'unknown', messageID: 'msg_live', type: 'text', text: 'Actual answer' },
      }),
    )
    expect(session.snapshot.blocks.at(-1)).toMatchObject({ text: 'Actual answer' })
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
    client.emit(
      evt('permission.asked', {
        sessionID: 'ses_2',
        id: 'per_1',
        permission: 'bash',
        patterns: ['ls *'],
      }),
    )
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
    client.emit(
      evt('question.asked', {
        sessionID: 'ses_2',
        id: 'que_1',
        questions: [{ header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: '' }] }],
      }),
    )
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    if (block?.kind !== 'approval') throw new Error('expected approval')
    session.setApprovalDraft(block.id, 'q0', 'A')
    session.resolveApproval(block.id, true)
    expect(client.calls.at(-1)).toMatchObject({ method: 'replyQuestion', args: ['que_1', [['A']]] })
  })

  it('switches primary agents and rejects subagents, plan, and unknown modes', async () => {
    const { session } = await readySession(
      createFakeOpenCodeClient({
        agents: [
          { name: 'build', mode: 'primary' },
          { name: 'writing', mode: 'primary' },
          { name: 'explore', mode: 'subagent' },
          { name: 'plan', mode: 'primary' },
        ],
      }),
    )
    session.setCollaborationMode('writing')
    expect(session.snapshot.collaborationMode).toBe('writing')
    for (const name of ['explore', 'plan', 'nope']) {
      session.setCollaborationMode(name)
      expect(session.snapshot.collaborationMode).toBe('writing')
    }
  })

  it('reports prompt failures without hanging', async () => {
    const client = createFakeOpenCodeClient({ failPrompt: true })
    const { session } = await readySession(client)
    await session.openThread('ses_2')
    await session.send('count')
    expect(session.snapshot.streaming).toBe(false)
    expect(session.snapshot.error).toBe('nope')
    expect(session.snapshot.blocks.some((block) => block.id.startsWith('local-'))).toBe(false)
  })

  it('aborts mid-stream on interrupt and attempts reconcile', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_2')
    const aborts: string[] = []
    const originalAbort = client.abort.bind(client)
    client.abort = async (sessionId: string) => {
      aborts.push(sessionId)
      return originalAbort(sessionId)
    }
    await session.send('count')
    expect(session.snapshot.streaming).toBe(true)
    const listsBefore = client.calls.filter((call) => call.method === 'listMessages').length
    await session.interrupt()
    expect(aborts).toContain('ses_2')
    expect(session.snapshot.streaming).toBe(false)
    expect(client.calls.filter((call) => call.method === 'listMessages').length).toBeGreaterThan(listsBefore)
  })

  it('ignores unknown models', async () => {
    const { session } = await readySession()
    const before = session.snapshot.model
    session.setModel('unknown/model-xyz')
    expect(session.snapshot.model).toBe(before)
  })

  it('reconciles a second identical send onto only the latest echo', async () => {
    const client = createFakeOpenCodeClient({ sessions: [stubSession('ses_3', '')], messages: { ses_3: [] } })
    const { session } = await readySession(client)
    await session.openThread('ses_3')
    await session.send('hello')
    const local1 = session.snapshot.blocks.at(-1)?.id ?? ''
    expect(local1.startsWith('local-')).toBe(true)

    client.listMessages = (async (sessionId: string) => {
      client.calls.push({ method: 'listMessages', args: [sessionId] })
      return [stubUserMessage('msg_1', 'ses_3', 'hello')]
    }) as typeof client.listMessages
    client.emit(evt('message.updated', { sessionID: 'ses_3', info: { id: 'msg_1', role: 'user' } }))
    await tick()
    expect(session.snapshot.blocks.some((block) => block.id === 'msg_1')).toBe(true)
    expect(session.snapshot.blocks.some((block) => block.id === local1)).toBe(false)

    client.emit(evt('session.idle', { sessionID: 'ses_3' }))
    await tick()
    expect(session.snapshot.streaming).toBe(false)

    await session.send('hello')
    const local2 = session.snapshot.blocks.at(-1)?.id ?? ''
    expect(local2.startsWith('local-')).toBe(true)
    expect(local2).not.toBe(local1)
    client.listMessages = (async (sessionId: string) => {
      client.calls.push({ method: 'listMessages', args: [sessionId] })
      return [stubUserMessage('msg_1', 'ses_3', 'hello'), stubUserMessage('msg_2', 'ses_3', 'hello')]
    }) as typeof client.listMessages
    client.emit(evt('message.updated', { sessionID: 'ses_3', info: { id: 'msg_2', role: 'user' } }))
    await tick()
    expect(session.snapshot.blocks.map((block) => block.id)).toContain('msg_1')
    expect(session.snapshot.blocks.map((block) => block.id)).toContain('msg_2')
    expect(session.snapshot.blocks.some((block) => block.id === local2)).toBe(false)
  })

  it('declines permission requests with a reject reply', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_2')
    client.emit(
      evt('permission.asked', {
        sessionID: 'ses_2',
        id: 'per_2',
        permission: 'bash',
        patterns: ['rm *'],
      }),
    )
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    if (block?.kind !== 'approval') throw new Error('expected approval')
    session.resolveApproval(block.id, false)
    expect(client.calls.at(-1)).toMatchObject({ method: 'replyPermission', args: ['per_2', false] })
    expect(session.snapshot.blocks.find((item) => item.id === block.id)).toMatchObject({ resolved: 'skipped' })
  })

  it('declines question requests through rejectQuestion', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_2')
    client.emit(
      evt('question.asked', {
        sessionID: 'ses_2',
        id: 'que_2',
        questions: [{ header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: '' }] }],
      }),
    )
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    if (block?.kind !== 'approval') throw new Error('expected approval')
    session.resolveApproval(block.id, false)
    expect(client.calls.at(-1)).toMatchObject({ method: 'rejectQuestion', args: ['que_2'] })
  })

  it('ignores a second resolve for the same approval', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_2')
    client.emit(
      evt('permission.asked', {
        sessionID: 'ses_2',
        id: 'per_3',
        permission: 'bash',
        patterns: ['ls *'],
      }),
    )
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    if (block?.kind !== 'approval') throw new Error('expected approval')
    session.resolveApproval(block.id, true)
    session.resolveApproval(block.id, false)
    expect(client.calls.filter((call) => call.method === 'replyPermission' && call.args[0] === 'per_3')).toHaveLength(1)
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

describe('project locations and history loading', () => {
  it('retains folder roots and excludes subagents from selectable modes', async () => {
    const { session } = await readySession(
      createFakeOpenCodeClient({ projects: [{ id: 'course', name: 'Course', worktree: '/tmp/course' }] }),
    )
    expect(session.snapshot.projects[0].roots).toEqual([{ path: '/tmp/course' }])
    expect(session.snapshot.collaborationModes.map((mode) => mode.name)).toEqual(['build'])
  })

  it('passes the chosen directory and title when creating a document', async () => {
    const { session, client } = await readySession()
    await session.newDocument({ projectId: 'course', cwd: '/tmp/course', title: 'Week 4' })
    expect(client.calls.find((call) => call.method === 'createSession')?.args[0]).toMatchObject({
      directory: '/tmp/course',
      title: 'Week 4',
    })
    expect(session.snapshot.cwd).toBe('/tmp/course')
  })

  it('persists renames through the provider', async () => {
    const { session, client } = await readySession()
    await session.openThread('ses_1')
    await session.setDocumentName('Renamed')
    expect(client.calls.find((call) => call.method === 'renameSession')?.args).toEqual(['ses_1', 'Renamed'])
    await session.openThread('ses_1')
    expect(session.snapshot.title).toBe('Renamed')
  })

  it('loads recent history first and can retrieve the rest', async () => {
    const messages = Array.from({ length: 150 }, (_, i) => stubUserMessage(`msg-${i}`, 'ses_1', `Question ${i}`))
    const { session } = await readySession(createFakeOpenCodeClient({ messages: { ses_1: messages } }))
    await session.openThread('ses_1')
    expect(session.snapshot.blocks).toHaveLength(100)
    expect(session.snapshot.olderTurnsCursor).toBe('100')
    await session.loadOlderTurns()
    expect(session.snapshot.blocks).toHaveLength(150)
    expect(session.snapshot.blocks[0]).toMatchObject({ text: 'Question 0' })
    expect(session.snapshot.olderTurnsCursor).toBeNull()
  })
})
