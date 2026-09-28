import type { Project } from '../generated/codex/v2/Project'
import type { Account } from '../generated/codex/v2/Account'
import type { Model } from '../generated/codex/v2/Model'
import type { Thread } from '../generated/codex/v2/Thread'
import type { ThreadStartResponse } from '../generated/codex/v2/ThreadStartResponse'
import type { ThreadResumeResponse } from '../generated/codex/v2/ThreadResumeResponse'
import type { Turn } from '../generated/codex/v2/Turn'
import type { JsonRpcId } from './jsonrpc'
import type { CodexTransport, NotificationHandler, ServerRequestHandler } from './transport'

export function stubThread(id: string, preview: string, name?: string, projectId?: string | null): Thread {
  return {
    id,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: projectId ?? null,
    historyMode: 'legacy',
    modelProvider: 'openai',
    model: null,
    reasoningEffort: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    recencyAt: 1_700_000_000,
    status: { type: 'notLoaded' },
    path: null,
    cwd: '/tmp',
    cliVersion: '0',
    source: 'vscode',
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: name ?? null,
    turns: [],
  }
}

export function stubModel(): Model {
  return {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Normal text',
    description: '',
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Low' },
      { reasoningEffort: 'medium', description: 'Medium' },
      { reasoningEffort: 'high', description: 'High' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: [],
    supportsPersonality: true,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [
      { id: 'standard', name: 'Standard', description: 'Standard speed' },
      { id: 'fast', name: 'Fast', description: 'Fast speed' },
    ],
    defaultServiceTier: 'standard',
    isDefault: true,
  }
}

export function stubTurn(id: string, items: Turn['items'] = []): Turn {
  return {
    id,
    items,
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  }
}

export type FakeTransport = CodexTransport & {
  calls: Array<{ method: string; params: unknown }>
  emitNotification: (method: string, params: unknown) => void
  emitRequest: (id: JsonRpcId, method: string, params: unknown) => void
  responses: Array<{ id: JsonRpcId; result: unknown }>
}

export function createFakeTransport(options?: {
  projects?: Project[]
  threads?: Thread[]
  account?: Account | null
  turns?: Turn[]
  olderTurns?: Turn[]
  failResume?: string
  resumeGate?: { wait: Promise<void> }
  requiresOpenaiAuth?: boolean
}): FakeTransport {
  const threads = options?.threads ?? [
    stubThread('thr_1', 'Essay on photosynthesis', 'Photosynthesis'),
    stubThread('thr_2', 'Lab notes', 'Chem lab'),
  ]
  const projects = options?.projects ?? []
  const account: Account | null =
    options?.account === undefined ? { type: 'chatgpt', email: 'yan@school.edu', planType: 'plus' } : options.account
  const notes = new Set<NotificationHandler>()
  const reqs = new Set<ServerRequestHandler>()
  const model = stubModel()
  const turns = options?.turns ?? []
  const olderTurns = options?.olderTurns ?? []
  const calls: FakeTransport['calls'] = []
  const responses: FakeTransport['responses'] = []

  const handlers: Record<string, (params: unknown) => unknown> = {
    initialize: () => ({ userAgent: 'hidegpt-test', codexHome: '/tmp' }),
    'account/read': () => ({
      account,
      requiresOpenaiAuth: options?.requiresOpenaiAuth ?? account == null,
    }),
    'model/list': () => ({ data: [model], nextCursor: null }),
    'thread/list': (params) => {
      const search = (params as { searchTerm?: string | null }).searchTerm?.toLowerCase()
      const data = search
        ? threads.filter(
            (thread) => thread.name?.toLowerCase().includes(search) || thread.preview.toLowerCase().includes(search),
          )
        : threads
      return { data, nextCursor: null, backwardsCursor: null }
    },
    'project/list': () => ({ data: projects, nextCursor: null }),
    'project/create': (params) => {
      const input = params as { name: string; roots: Project['roots'] }
      const project: Project = {
        id: `proj-${projects.length}`,
        ...input,
        metadata: {},
        position: 0,
        createdAt: 0,
        updatedAt: 0,
        recencyAt: null,
      }
      projects.push(project)
      return { project }
    },
    'mcpServerStatus/list': () => ({ data: [], nextCursor: null }),
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    'thread/turns/list': (params) => {
      const cursor = (params as { cursor?: string | null }).cursor
      return cursor
        ? { data: olderTurns, nextCursor: null, backwardsCursor: null }
        : {
            data: [...turns].reverse(),
            nextCursor: null,
            backwardsCursor: olderTurns.length ? 'older' : null,
          }
    },
    'collaborationMode/list': () => ({
      data: [
        { name: 'Plan', mode: 'plan', model: null, reasoning_effort: null },
        { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
      ],
    }),
    'account/rateLimits/read': () => ({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: 'plus',
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
      accountId: null,
      rateLimitUpsell: null,
    }),
    'thread/start': (params) => {
      const input = params as { cwd?: string; projectId?: string }
      const thread = { ...stubThread('thr_new', '', 'Untitled document', input.projectId), cwd: input.cwd ?? '/tmp' }
      threads.push(thread)
      return {
        thread,
        model: model.model,
        modelProvider: 'openai',
        serviceTier: null,
        cwd: thread.cwd,
        runtimeWorkspaceRoots: [],
        instructionSources: [],
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        activePermissionProfile: null,
        reasoningEffort: 'medium',
        multiAgentMode: 'explicitRequestOnly',
      } as ThreadStartResponse
    },
    'thread/resume': async (params) => {
      if (options?.resumeGate) await options.resumeGate.wait
      const threadId = (params as { threadId: string }).threadId
      if (options?.failResume === threadId) {
        throw new Error('thread-store conflict: already has an active writer')
      }
      const thread = threads.find((item) => item.id === threadId) ?? stubThread(threadId, 'Untitled')
      return {
        thread: { ...thread, turns: [] },
        model: model.model,
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp',
        runtimeWorkspaceRoots: [],
        instructionSources: [],
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        activePermissionProfile: null,
        reasoningEffort: 'medium',
        multiAgentMode: 'explicitRequestOnly',
        initialTurnsPage: {
          data: [...turns].reverse(),
          nextCursor: null,
          backwardsCursor: olderTurns.length ? 'older' : null,
        },
        turnsBackwardsCursor: olderTurns.length ? 'older' : null,
        itemsBackwardsCursor: null,
      } as ThreadResumeResponse
    },
    'turn/start': () => ({
      turn: {
        id: 'turn_1',
        items: [],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      },
    }),
    'turn/interrupt': () => ({}),
    'account/logout': () => ({}),
    'account/login/start': () => ({ type: 'chatgpt', loginId: 'login', authUrl: 'https://example.test/login' }),
    'mcpServer/oauth/login': () => ({ authorizationUrl: 'https://example.test/mcp' }),
    'thread/increment_elicitation': () => ({}),
    'thread/decrement_elicitation': () => ({}),
    'thread/name/set': (params) => {
      const { threadId, name } = params as { threadId: string; name: string }
      const thread = threads.find((item) => item.id === threadId)
      if (thread) thread.name = name
      return {}
    },
  }

  return {
    calls,
    responses,
    request<T>(method: string, params?: unknown) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (!handler) return Promise.reject(new Error(`unexpected ${method}`))
      try {
        return Promise.resolve(handler(params)) as Promise<T>
      } catch (error) {
        return Promise.reject(error)
      }
    },
    notify() {},
    respond(id: JsonRpcId, result: unknown) {
      responses.push({ id, result })
    },
    reject() {},
    onNotification(handler) {
      notes.add(handler)
      return () => notes.delete(handler)
    },
    onRequest(handler) {
      reqs.add(handler)
      return () => reqs.delete(handler)
    },
    onDisconnect() {
      return () => {}
    },
    async close() {},
    emitNotification(method, params) {
      for (const handler of notes) handler(method, params)
    },
    emitRequest(id, method, params) {
      for (const handler of reqs) handler({ id, method, params })
    },
  }
}
