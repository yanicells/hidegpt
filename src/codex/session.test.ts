import { describe, expect, it } from 'vitest'

import { createFakeTransport, stubThread, stubTurn } from './fake'
import { CodexSession, formatCodexError } from './session'

async function readySession(options?: Parameters<typeof createFakeTransport>[0]) {
  const transport = createFakeTransport(options)
  const session = new CodexSession(() => transport)
  await session.start()
  return { session, transport }
}

describe('formatCodexError', () => {
  it('explains writer-lock conflicts', () => {
    expect(formatCodexError('thread-store conflict: already has an active writer')).toContain(
      'open in ChatGPT',
    )
  })
})

describe('CodexSession', () => {
  it('lists threads after handshake', async () => {
    const { session } = await readySession()
    expect(session.snapshot.status).toBe('ready')
    expect(session.snapshot.threads.map((thread) => thread.id)).toEqual(['thr_1', 'thr_2'])
  })

  it('does not ask for ChatGPT login when an account is already present', async () => {
    const { session } = await readySession({ requiresOpenaiAuth: true })
    expect(session.snapshot.account).toBeTruthy()
    expect(session.snapshot.requiresAuth).toBe(false)
  })

  it('resumes recent turns in chronological order and keeps an older cursor', async () => {
    const { session, transport } = await readySession({
      turns: [
        stubTurn('t-old', [
          {
            type: 'userMessage',
            id: 'u1',
            clientId: null,
            content: [{ type: 'text', text: 'older question', text_elements: [] }],
          },
        ]),
        stubTurn('t-new', [
          {
            type: 'agentMessage',
            id: 'a1',
            text: 'newer',
            phase: null,
            memoryCitation: null,
            delivery: null,
          },
        ]),
      ],
      olderTurns: [
        stubTurn('ancient', [
          {
            type: 'userMessage',
            id: 'u0',
            clientId: null,
            content: [{ type: 'text', text: 'first question', text_elements: [] }],
          },
        ]),
      ],
    })
    await session.openThread('thr_1')
    const resume = transport.calls.find((call) => call.method === 'thread/resume')
    expect(resume?.params).toMatchObject({
      threadId: 'thr_1',
      excludeTurns: true,
      initialTurnsPage: { sortDirection: 'desc', itemsView: 'full' },
    })
    expect(session.snapshot.blocks.map((block) => block.id)).toEqual(['u1', 'a1'])
    expect(session.snapshot.olderTurnsCursor).toBe('older')

    await session.loadOlderTurns()
    expect(session.snapshot.blocks[0]).toMatchObject({ id: 'u0', kind: 'user' })
    expect(session.snapshot.olderTurnsCursor).toBeNull()
  })

  it('unsubscribes before opening another thread', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    await session.openThread('thr_2')
    const methods = transport.calls.map((call) => call.method)
    expect(methods.filter((method) => method === 'thread/unsubscribe')).toEqual(['thread/unsubscribe'])
    expect(transport.calls.some((call) => call.method === 'thread/resume' && (call.params as { threadId: string }).threadId === 'thr_2')).toBe(true)
  })

  it('does not start a second turn while streaming', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    await session.send('one')
    await session.send('two')
    expect(transport.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  })

  it('surfaces turn errors and rate-limit updates', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    transport.emitNotification('error', {
      error: { message: 'rate limited', codexErrorInfo: 'rateLimitExceeded', additionalDetails: null, misalignment: null },
      willRetry: false,
      threadId: 'thr_1',
      turnId: 't1',
    })
    expect(session.snapshot.error).toBe('rate limited')
    expect(session.snapshot.streaming).toBe(false)

    transport.emitNotification('account/rateLimits/updated', {
      rateLimits: {
        ...session.snapshot.rateLimits!.rateLimits,
        primary: { usedPercent: 88, windowDurationMins: 300, resetsAt: null },
      },
    })
    expect(session.snapshot.rateLimits?.rateLimits.primary?.usedPercent).toBe(88)
  })

  it('answers currentTime and dynamic tool calls', async () => {
    const { session, transport } = await readySession()
    transport.emitRequest(11, 'currentTime/read', {})
    transport.emitRequest(12, 'item/tool/call', { tool: 'x' })
    expect(transport.responses[0]?.id).toBe(11)
    expect(transport.responses[1]?.result).toMatchObject({ success: false })
    expect(session.snapshot.status).toBe('ready')
  })

  it('collects MCP form drafts on accept', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    transport.emitRequest(21, 'mcpServer/elicitation/request', {
      threadId: 'thr_1',
      turnId: 't1',
      serverName: 'notion',
      mode: 'form',
      _meta: null,
      message: 'Connect Notion',
      requestedSchema: {
        type: 'object',
        properties: { token: { type: 'string', title: 'Token' } },
      },
    })
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    expect(block?.kind).toBe('approval')
    if (block?.kind !== 'approval') return
    session.setApprovalDraft(block.id, 'token', 'secret')
    session.resolveApproval(block.id, true)
    expect(transport.responses.at(-1)?.result).toMatchObject({
      action: 'accept',
      content: { token: 'secret' },
    })
  })

  it('collects MCP openai/form drafts on accept', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    transport.emitRequest(22, 'mcpServer/elicitation/request', {
      threadId: 'thr_1',
      turnId: 't1',
      serverName: 'notion',
      mode: 'openai/form',
      _meta: null,
      message: 'Connect Notion',
      requestedSchema: {
        type: 'object',
        properties: { workspace: { type: 'string', title: 'Workspace' } },
      },
    })
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    expect(block?.kind).toBe('approval')
    if (block?.kind !== 'approval') return
    session.setApprovalDraft(block.id, 'workspace', 'eva')
    session.resolveApproval(block.id, true)
    expect(transport.responses.at(-1)?.result).toMatchObject({
      action: 'accept',
      content: { workspace: 'eva' },
    })
  })

  it('returns an answer slot for every user-input question', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    transport.emitRequest(23, 'item/tool/requestUserInput', {
      threadId: 'thr_1',
      turnId: 't1',
      itemId: 'i1',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        { id: 'q1', header: '', question: 'Pick one', isOther: false, isSecret: false, options: [{ label: 'A', description: '' }] },
      ],
    })
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    if (block?.kind !== 'approval') throw new Error('expected approval')
    session.resolveApproval(block.id, true)
    expect(transport.responses.at(-1)?.result).toEqual({ answers: { q1: { answers: [] } } })
  })

  it('drops thread events after going home', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    session.goHome()
    transport.emitNotification('item/agentMessage/delta', {
      threadId: 'thr_1',
      itemId: 'x',
      delta: 'nope',
    })
    expect(session.snapshot.route.kind).toBe('home')
    expect(session.snapshot.blocks).toEqual([])
  })

  it('returns home with a friendly error when resume is locked', async () => {
    const { session } = await readySession({ failResume: 'thr_1' })
    await session.openThread('thr_1')
    expect(session.snapshot.route.kind).toBe('home')
    expect(session.snapshot.error).toContain('open in ChatGPT')
  })

  it('renames the open document', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    await session.setDocumentName('Lab report')
    expect(session.snapshot.title).toBe('Lab report')
    expect(transport.calls.some((call) => call.method === 'thread/name/set')).toBe(true)
    expect(session.snapshot.threads.find((thread) => thread.id === 'thr_1')?.name).toBe('Lab report')
  })

  it('hides reasoning and plans, showing outputs only', async () => {
    const { session } = await readySession({
      turns: [
        stubTurn('t1', [
          {
            type: 'userMessage',
            id: 'u1',
            clientId: null,
            content: [{ type: 'text', text: 'explain this', text_elements: [] }],
          },
          { type: 'reasoning', id: 'r1', summary: ['thinking'], content: ['deep thought'] },
          { type: 'plan', id: 'p1', text: 'my plan' },
          {
            type: 'agentMessage',
            id: 'a1',
            text: 'the answer',
            phase: null,
            memoryCitation: null,
            delivery: null,
          },
        ]),
      ],
    })
    await session.openThread('thr_1')
    expect(session.snapshot.blocks.map((block) => block.id)).toEqual(['u1', 'a1'])
  })

  it('replaces the optimistic echo instead of duplicating it', async () => {    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    await session.send('same text')
    const local = session.snapshot.blocks.at(-1)
    expect(local).toMatchObject({ kind: 'user', text: 'same text' })
    transport.emitNotification('item/started', {
      threadId: 'thr_1',
      item: {
        type: 'userMessage',
        id: 'u-server',
        clientId: null,
        content: [{ type: 'text', text: 'same text', text_elements: [] }],
      },
    })
    const users = session.snapshot.blocks.filter((block) => block.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ id: 'u-server', text: 'same text' })
  })

  it('does not offer plan mode', async () => {
    const { session } = await readySession()
    expect(session.snapshot.collaborationModes.map((mode) => mode.name)).toEqual(['Default'])
    expect(session.snapshot.collaborationMode).toBe('Default')
  })

  it('sends the selected speed tier with new turns', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    session.setSpeed('fast')
    expect(session.snapshot.speed).toBe('fast')
    await session.send('go fast')
    const turn = transport.calls.find((call) => call.method === 'turn/start')
    expect(turn?.params).toMatchObject({ serviceTierForTurn: 'fast' })
    session.setModel('gpt-5.6-sol')
    expect(session.snapshot.speed).toBeNull()
  })

  it('does not reopen a document after the user goes home', async () => {
    let release = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const { session, transport } = await readySession({ resumeGate: { wait } })
    const opening = session.openThread('thr_1')
    await Promise.resolve()
    session.goHome()
    release()
    await opening
    expect(session.snapshot.route.kind).toBe('home')
    expect(session.snapshot.blocks).toEqual([])
  })
})
