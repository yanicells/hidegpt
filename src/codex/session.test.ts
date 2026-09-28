import { describe, expect, it, vi } from 'vitest'

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
    expect(formatCodexError('thread-store conflict: already has an active writer')).toContain('open in ChatGPT')
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
            questions: null,
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
    expect(
      transport.calls.some(
        (call) => call.method === 'thread/resume' && (call.params as { threadId: string }).threadId === 'thr_2',
      ),
    ).toBe(true)
  })

  it('does not start a second turn while streaming', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    await session.send('one')
    await session.send('two')
    expect(transport.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  })

  it('is ready after the first page of documents and fills in the rest later', async () => {
    let release = () => {}
    const laterPages = new Promise<void>((resolve) => (release = resolve))
    const threads = Array.from({ length: 5 }, (_, index) => stubThread(`thr_${index}`, `Doc ${index}`))
    const transport = createFakeTransport({ threads, threadPageSize: 2, laterPages })
    const session = new CodexSession(() => transport)
    await session.start()
    expect(session.snapshot.status).toBe('ready')
    expect(session.snapshot.threads.map((thread) => thread.id)).toEqual(['thr_0', 'thr_1'])
    release()
    await vi.waitFor(() => expect(session.snapshot.threads).toHaveLength(5))
  })

  it('sends pasted images and a chosen skill as structured input', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    expect(session.snapshot.skills.map((skill) => skill.name)).toEqual(['humanizer', 'study-guide'])
    await session.send('make this sound like me', { skill: 'humanizer', images: ['/tmp/a.png'] })
    const turn = transport.calls.find((call) => call.method === 'turn/start')
    expect((turn?.params as { input: unknown }).input).toEqual([
      { type: 'text', text: 'make this sound like me', text_elements: [] },
      { type: 'localImage', path: '/tmp/a.png' },
      { type: 'skill', name: 'humanizer', path: '/tmp/skills/humanizer/SKILL.md' },
    ])
    transport.emitNotification('item/started', {
      threadId: 'thr_1',
      item: {
        type: 'userMessage',
        id: 'server-1',
        clientId: null,
        content: (turn?.params as { input: unknown }).input,
      },
    })
    expect(session.snapshot.blocks).toEqual([
      {
        kind: 'user',
        id: 'server-1',
        text: 'make this sound like me',
        images: ['/tmp/a.png'],
        skills: ['humanizer'],
      },
    ])
  })

  it('sends an image-only message', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    await session.send('  ', { images: ['/tmp/a.png'] })
    const turn = transport.calls.find((call) => call.method === 'turn/start')
    expect((turn?.params as { input: unknown }).input).toEqual([{ type: 'localImage', path: '/tmp/a.png' }])
  })

  it('surfaces turn errors and rate-limit updates', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    transport.emitNotification('error', {
      error: {
        message: 'rate limited',
        codexErrorInfo: 'rateLimitExceeded',
        additionalDetails: null,
        misalignment: null,
      },
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
        {
          id: 'q1',
          header: '',
          question: 'Pick one',
          isOther: false,
          isSecret: false,
          options: [{ label: 'A', description: '' }],
        },
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
            questions: null,
          },
        ]),
      ],
    })
    await session.openThread('thr_1')
    expect(session.snapshot.blocks.map((block) => block.id)).toEqual(['u1', 'a1'])
  })

  it('replaces the optimistic echo instead of duplicating it', async () => {
    const { session, transport } = await readySession()
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
    session.setServiceTier('fast')
    expect(session.snapshot.serviceTier).toBe('fast')
    await session.send('go fast')
    const turn = transport.calls.find((call) => call.method === 'turn/start')
    expect(turn?.params).toMatchObject({ serviceTierForTurn: 'fast' })
    session.setModel('gpt-5.6-sol')
    expect(session.snapshot.serviceTier).toBeNull()
  })

  it('sends null for the default tier and passes unknown tiers through', async () => {
    const first = await readySession()
    await first.session.openThread('thr_1')
    first.session.setServiceTier(null)
    await first.session.send('standard speed')
    const standardTurn = first.transport.calls.find((call) => call.method === 'turn/start')
    expect(standardTurn?.params).toMatchObject({ serviceTierForTurn: null })

    const second = await readySession()
    await second.session.openThread('thr_1')
    second.session.setServiceTier('mystery-tier')
    await second.session.send('mystery speed')
    const mysteryTurn = second.transport.calls.find((call) => call.method === 'turn/start')
    expect(mysteryTurn?.params).toMatchObject({ serviceTierForTurn: 'mystery-tier' })
  })

  it('keeps a server echo with different text as a second user block', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    await session.send('original text')
    transport.emitNotification('item/started', {
      threadId: 'thr_1',
      item: {
        type: 'userMessage',
        id: 'u-server',
        clientId: null,
        content: [{ type: 'text', text: 'different text', text_elements: [] }],
      },
    })
    const users = session.snapshot.blocks.filter((block) => block.kind === 'user')
    expect(users).toHaveLength(2)
    expect(users[0]).toMatchObject({ text: 'original text' })
    expect(users[1]).toMatchObject({ id: 'u-server', text: 'different text' })
  })

  it('reconciles two identical sends independently without cross-talk', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    await session.send('same text')
    transport.emitNotification('item/started', {
      threadId: 'thr_1',
      item: {
        type: 'userMessage',
        id: 'u-1',
        clientId: null,
        content: [{ type: 'text', text: 'same text', text_elements: [] }],
      },
    })
    expect(session.snapshot.blocks.filter((block) => block.kind === 'user')).toHaveLength(1)
    transport.emitNotification('turn/completed', {
      threadId: 'thr_1',
      turn: { id: 'turn_1', status: 'completed', error: null },
    })
    expect(session.snapshot.streaming).toBe(false)
    await session.send('same text')
    transport.emitNotification('item/started', {
      threadId: 'thr_1',
      item: {
        type: 'userMessage',
        id: 'u-2',
        clientId: null,
        content: [{ type: 'text', text: 'same text', text_elements: [] }],
      },
    })
    const users = session.snapshot.blocks.filter((block) => block.kind === 'user')
    expect(users.map((block) => block.id)).toEqual(['u-1', 'u-2'])
  })

  it('declines commandExecution approvals with decline', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    transport.emitRequest(31, 'item/commandExecution/requestApproval', {
      threadId: 'thr_1',
      command: 'ls',
      reason: 'list files',
    })
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    expect(block?.kind).toBe('approval')
    if (block?.kind !== 'approval') return
    session.resolveApproval(block.id, false)
    expect(transport.responses.at(-1)).toMatchObject({ id: 31, result: { decision: 'decline' } })
  })

  it('declines fileChange approvals with decline', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    transport.emitRequest(32, 'item/fileChange/requestApproval', {
      threadId: 'thr_1',
      reason: 'edit files',
    })
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    expect(block?.kind).toBe('approval')
    if (block?.kind !== 'approval') return
    session.resolveApproval(block.id, false)
    expect(transport.responses.at(-1)).toMatchObject({ id: 32, result: { decision: 'decline' } })
  })

  it('ignores a second resolveApproval for the same request', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    transport.emitRequest(33, 'item/commandExecution/requestApproval', {
      threadId: 'thr_1',
      command: 'ls',
    })
    const block = session.snapshot.blocks.find((item) => item.kind === 'approval')
    if (block?.kind !== 'approval') throw new Error('expected approval')
    session.resolveApproval(block.id, true)
    session.resolveApproval(block.id, false)
    expect(transport.responses.filter((response) => response.id === 33)).toHaveLength(1)
  })

  it('interrupts the turn and clears streaming', async () => {
    const { session, transport } = await readySession()
    await session.openThread('thr_1')
    await session.send('hello')
    expect(session.snapshot.streaming).toBe(true)
    await session.interrupt()
    expect(transport.calls.some((call) => call.method === 'turn/interrupt')).toBe(true)
    expect(session.snapshot.streaming).toBe(false)
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

describe('project creation and opening feedback', () => {
  it('persists a selected project and directory on new threads', async () => {
    const { session, transport } = await readySession()
    await session.newDocument({ projectId: 'course', cwd: '/tmp/course' })
    expect(transport.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
      projectId: 'course',
      cwd: '/tmp/course',
    })
    expect(session.snapshot.cwd).toBe('/tmp/course')
  })

  it('does not inherit the previous project directory for an unfiled document', async () => {
    const { session, transport } = await readySession()
    session.setFolderDraft('/tmp/previous-project')
    session.applyFolder()
    await session.newDocument({ projectId: null })
    expect(transport.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
      projectId: null,
      cwd: expect.stringContaining('/.codex/threads'),
    })
  })

  it('creates a provider project and refreshes its catalog', async () => {
    const { session, transport } = await readySession()
    await session.createProject('Course notes', '/tmp/course')
    expect(session.snapshot.projects[0]).toMatchObject({ name: 'Course notes', roots: [{ path: '/tmp/course' }] })
    expect(transport.calls.find((call) => call.method === 'project/create')?.params).toMatchObject({
      idempotencyKey: expect.any(String),
    })
  })

  it('clears pending navigation on cancel and ignores its late response', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const { session } = await readySession({ resumeGate: { wait } })
    const opening = session.openThread('thr_1')
    expect(session.snapshot.openingThreadId).toBe('thr_1')
    session.goHome()
    release()
    await opening
    expect(session.snapshot.openingThreadId).toBeNull()
    expect(session.snapshot.route.kind).toBe('home')
  })
})
