import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import * as CodexClient from '../vendor/effect-codex-app-server/client.ts'
import * as CodexError from '../vendor/effect-codex-app-server/errors.ts'
import type * as CodexRpc from '../vendor/effect-codex-app-server/rpc.ts'
import { makeInMemoryStdio } from '../vendor/effect-codex-app-server/_internal/stdio.ts'
import type { Connect } from './CodexAdapter'

/**
 * An in-process stand-in for `codex app-server`. It reads and writes real
 * JSON-RPC lines over in-memory stdio, so the vendored client (schemas, ids,
 * server requests, termination) runs exactly as it does against the real
 * process; only the process boundary is replaced. Library state (threads,
 * turns) survives reconnects like Codex's on-disk store. Used by tests, demo
 * mode (`HIDEGPT_FAKE=1`), and the bench.
 */

type Method = CodexRpc.ClientRequestMethod
type Params<M extends Method> = CodexRpc.ClientRequestParamsByMethod[M]
type Result<M extends Method> = CodexRpc.ClientRequestResponsesByMethod[M]
type NotificationMethod = CodexRpc.ServerNotificationMethod
type Notification<M extends NotificationMethod> = CodexRpc.ServerNotificationParamsByMethod[M]

export type Thread = Result<'thread/list'>['data'][number]
export type Turn = Result<'thread/turns/list'>['data'][number]
export type Project = Result<'project/list'>['data'][number]
export type Model = Result<'model/list'>['data'][number]
type Item = Turn['items'][number]

/** A JSON-RPC error the fake answers with. */
export type RpcFailure = { readonly code: number; readonly message: string }
export const rpcFailure = (message: string, code = -32000): RpcFailure => ({ code, message })

export type Handler<M extends Method> = (params: Params<M>) => Effect.Effect<Result<M>, RpcFailure>
export type Handlers = { readonly [M in Method]?: Handler<M> }

export type FakeCodexOptions = {
  readonly threads?: ReadonlyArray<Thread>
  readonly projects?: ReadonlyArray<Project>
  readonly account?: Result<'account/read'>['account']
  /** Turns every resumed thread starts with, oldest first. */
  readonly turns?: ReadonlyArray<Turn>
  /** The page `thread/turns/list` returns for the "older" cursor. */
  readonly olderTurns?: ReadonlyArray<Turn>
  /** Pages `thread/list` like a real library; unset returns everything at once. */
  readonly threadPageSize?: number
  /** What a turn answers; `null` makes turns wait for `turn/interrupt` (tests drive them by hand). */
  readonly reply?: ((text: string) => string) | null
  /** Milliseconds between streamed words. */
  readonly deltaDelayMs?: number
  /** Replaces or adds request handlers (failures, timeouts). */
  readonly handlers?: Handlers
  /** Runs before every request's handler, e.g. to hold one request until a test releases it. */
  readonly before?: (method: string, params: unknown) => Effect.Effect<void>
}

export interface FakeCodex {
  /** Opens a client against this peer; each call is a fresh "process". */
  readonly connect: Connect
  /** Every request the client sent, in order. */
  readonly calls: ReadonlyArray<{ readonly method: string; readonly params: unknown }>
  /** How many connections were opened (restarts). */
  readonly connections: () => number
  readonly threads: Array<Thread>
  /** Sends a notification to the live client. */
  readonly notify: <M extends NotificationMethod>(method: M, params: Notification<M>) => Effect.Effect<void>
  /** Ids of server requests still waiting on the client. */
  readonly pendingRequests: () => ReadonlyArray<number>
  /** Sends a server request and waits for the client's answer. */
  readonly request: <M extends CodexRpc.ServerRequestMethod>(
    method: M,
    params: CodexRpc.ServerRequestParamsByMethod[M],
  ) => Effect.Effect<unknown>
  /** Ends the live process as if it crashed: stdout closes, then it reports `code`. */
  readonly exit: (code: number, stderr?: string) => Effect.Effect<void>
}

const encoder = new TextEncoder()
const NOW = 1_700_000_000

export function stubThread(id: string, preview: string, name: string | null = null, projectId: string | null = null): Thread {
  return {
    id,
    sessionId: id,
    preview,
    ephemeral: false,
    projectId,
    modelProvider: 'openai',
    createdAt: NOW,
    updatedAt: NOW,
    recencyAt: NOW,
    status: { type: 'notLoaded' },
    cwd: '/tmp',
    cliVersion: '0',
    source: 'vscode',
    name,
    turns: [],
  }
}

export function stubTurn(id: string, items: ReadonlyArray<Item> = [], status: Turn['status'] = 'completed'): Turn {
  return { id, items: [...items], itemsView: 'full', status, error: null, startedAt: 1, completedAt: 2, durationMs: 1 }
}

export const userItem = (id: string, text: string, clientId: string | null = null): Item => ({
  type: 'userMessage',
  id,
  clientId,
  content: [{ type: 'text', text, text_elements: [] }],
})

export const agentItem = (id: string, text: string): Item => ({ type: 'agentMessage', id, text })

export function stubModel(): Model {
  return {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'Normal text',
    description: '',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Low' },
      { reasoningEffort: 'medium', description: 'Medium' },
      { reasoningEffort: 'high', description: 'High' },
    ],
    defaultReasoningEffort: 'medium',
    serviceTiers: [
      { id: 'standard', name: 'Standard', description: 'Standard speed' },
      { id: 'fast', name: 'Fast', description: 'Fast speed' },
    ],
    isDefault: true,
  }
}

const SESSION = {
  modelProvider: 'openai',
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: { type: 'readOnly' },
  reasoningEffort: 'medium',
} as const

const DEFAULT_REPLY = (text: string) =>
  `**Here is a first draft.** You asked: “${text.slice(0, 80)}”.\n\nA clear answer starts with the main idea, then supports it with one concrete example.\n\n1. State the idea in plain words.\n2. Give an example.\n3. Say why it matters.`

type Connection = {
  readonly send: (frame: unknown) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
  readonly scope: Scope.Scope
  exit: { code: number; stderr?: string }
}

export const makeFakeCodex = (options: FakeCodexOptions = {}): FakeCodex => {
  const threads: Thread[] = [...(options.threads ?? [stubThread('thr_1', 'Essay on photosynthesis', 'Photosynthesis'), stubThread('thr_2', 'Lab notes', 'Chem lab')])]
  const projects: Project[] = [...(options.projects ?? [])]
  const account = options.account === undefined ? { type: 'chatgpt' as const, email: 'student@school.edu', planType: 'plus' as const } : options.account
  const turnsByThread = new Map<string, Turn[]>()
  const olderTurns = options.olderTurns ?? []
  const calls: Array<{ method: string; params: unknown }> = []
  const running = new Map<string, Fiber.Fiber<void>>()
  const answers = new Map<number, Deferred.Deferred<unknown>>()
  const reply = options.reply === undefined ? DEFAULT_REPLY : options.reply
  const delay = options.deltaDelayMs ?? 0
  let live: Connection | null = null
  let connections = 0
  let nextServerId = 10_000
  let nextId = 0

  const turnsOf = (threadId: string) => {
    let turns = turnsByThread.get(threadId)
    if (!turns) {
      turns = [...(options.turns ?? [])]
      turnsByThread.set(threadId, turns)
    }
    return turns
  }
  const threadOf = (threadId: string) => threads.find((thread) => thread.id === threadId) ?? stubThread(threadId, 'Untitled')

  const notify = <M extends NotificationMethod>(method: M, params: Notification<M>) =>
    Effect.suspend(() => (live ? live.send({ method, params }) : Effect.void))

  /** Streams a scripted answer like a real turn: user echo (the sent input, as Codex echoes it), agent deltas, completion. */
  const runTurn = (threadId: string, turnId: string, input: Params<'turn/start'>['input'], clientId: string | null) =>
    Effect.gen(function* () {
      const text = input.map((part) => (part.type === 'text' ? part.text : '')).join('')
      const user: Item = { type: 'userMessage', id: `user-${turnId}`, clientId, content: [...input] }
      yield* notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress' } })
      yield* notify('item/completed', { threadId, turnId, item: user, completedAtMs: Date.now() })
      if (reply === null) return yield* Effect.never
      const answer = reply(text)
      const itemId = `agent-${turnId}`
      for (const word of answer.match(/\S+\s*/g) ?? []) {
        if (delay) yield* Effect.sleep(delay)
        yield* notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: word })
      }
      yield* notify('item/completed', { threadId, turnId, item: agentItem(itemId, answer), completedAtMs: Date.now() })
      turnsOf(threadId).push(stubTurn(turnId, [user, agentItem(itemId, answer)]))
      yield* notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'completed' } })
    }).pipe(Effect.ensuring(Effect.sync(() => running.delete(threadId))))

  const resumed = (threadId: string): Result<'thread/resume'> => {
    const turns = turnsOf(threadId)
    return {
      ...SESSION,
      thread: { ...threadOf(threadId), turns: [] },
      model: 'gpt-5.6-sol',
      cwd: threadOf(threadId).cwd,
      initialTurnsPage: { data: [...turns].reverse(), nextCursor: null, backwardsCursor: olderTurns.length ? 'older' : null },
      turnsBackwardsCursor: olderTurns.length ? 'older' : null,
    }
  }

  const defaults: Handlers = {
    initialize: () => Effect.succeed({ userAgent: 'hidegpt-fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' }),
    'account/read': () => Effect.succeed({ account, requiresOpenaiAuth: account == null }),
    'model/list': () => Effect.succeed({ data: [stubModel()], nextCursor: null }),
    'thread/list': (params) =>
      Effect.sync(() => {
        const search = params.searchTerm?.toLowerCase()
        const data = search
          ? threads.filter((thread) => thread.name?.toLowerCase().includes(search) || thread.preview.toLowerCase().includes(search))
          : threads
        const size = options.threadPageSize
        if (!size) return { data, nextCursor: null, backwardsCursor: null }
        const start = Number(params.cursor ?? 0)
        const end = start + size
        return { data: data.slice(start, end), nextCursor: end < data.length ? String(end) : null, backwardsCursor: null }
      }),
    'project/list': () => Effect.succeed({ data: projects, nextCursor: null }),
    'project/create': (params) =>
      Effect.sync(() => {
        const project: Project = {
          id: `proj-${projects.length}`,
          name: params.name,
          roots: params.roots,
          metadata: {},
          position: projects.length,
          createdAt: NOW,
          updatedAt: NOW,
        }
        projects.push(project)
        return { project }
      }),
    'mcpServerStatus/list': () => Effect.succeed({ data: [], nextCursor: null }),
    'collaborationMode/list': () =>
      Effect.succeed({
        data: [
          { name: 'Plan', mode: 'plan', model: null, reasoning_effort: null },
          { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
        ],
      }),
    'skills/list': (params) =>
      Effect.succeed({
        data: (params.cwds ?? []).map((cwd) => ({
          cwd,
          errors: [],
          skills: [
            { name: 'study-guide', description: 'Turn notes into a study guide', path: '/tmp/skills/study-guide/SKILL.md', scope: 'user', enabled: true },
            { name: 'humanizer', description: 'Rewrite text so it reads naturally', path: '/tmp/skills/humanizer/SKILL.md', scope: 'user', enabled: true },
          ],
        })),
      }),
    'thread/resume': (params) => Effect.sync(() => resumed(params.threadId)),
    'thread/start': (params) =>
      Effect.sync(() => {
        const now = Math.floor(Date.now() / 1000)
        const thread = {
          ...stubThread(`thr_new_${threads.length}`, '', null, params.projectId ?? null),
          cwd: params.cwd ?? '/tmp',
          createdAt: now,
          updatedAt: now,
          recencyAt: now,
        }
        threads.unshift(thread)
        return { ...SESSION, thread, model: params.model ?? 'gpt-5.6-sol', cwd: thread.cwd }
      }),
    'thread/turns/list': (params) =>
      Effect.sync(() =>
        params.cursor
          ? { data: olderTurns, nextCursor: null, backwardsCursor: null }
          : { data: [...turnsOf(params.threadId)].reverse(), nextCursor: null, backwardsCursor: olderTurns.length ? 'older' : null },
      ),
    'thread/unsubscribe': () => Effect.succeed({ status: 'unsubscribed' }),
    'thread/name/set': (params) =>
      Effect.sync(() => {
        const index = threads.findIndex((item) => item.id === params.threadId)
        if (index !== -1) threads[index] = { ...threads[index], name: params.name }
        return {}
      }),
    'turn/start': (params) =>
      Effect.gen(function* () {
        const turnId = `turn_${(nextId += 1)}`
        const connection = live
        if (connection) {
          const fiber = yield* Effect.forkIn(runTurn(params.threadId, turnId, params.input, params.clientUserMessageId ?? null), connection.scope)
          running.set(params.threadId, fiber)
        }
        return { turn: { id: turnId, items: [], status: 'inProgress' as const } }
      }),
    'turn/interrupt': (params) =>
      Effect.gen(function* () {
        const fiber = running.get(params.threadId)
        if (fiber) yield* Fiber.interrupt(fiber)
        yield* notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, items: [], status: 'interrupted' } })
        return {}
      }),
    'thread/increment_elicitation': () => Effect.succeed({ count: 1, paused: true }),
    'thread/decrement_elicitation': () => Effect.succeed({ count: 0, paused: false }),
    'account/logout': () => Effect.succeed({}),
    'account/login/start': () => Effect.succeed({ type: 'chatgpt' as const, loginId: 'login', authUrl: 'https://example.test/login' }),
    'mcpServer/oauth/login': () => Effect.succeed({ authorizationUrl: 'https://example.test/mcp' }),
  }
  const handlers = { ...defaults, ...options.handlers } as Record<string, (params: unknown) => Effect.Effect<unknown, RpcFailure>>

  const onFrame = (connection: Connection, line: string) =>
    Effect.suspend(() => {
      const frame = JSON.parse(line) as { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown }
      if (frame.method === undefined) {
        const answer = typeof frame.id === 'number' ? answers.get(frame.id) : undefined
        return answer ? Deferred.succeed(answer, frame.result ?? frame.error).pipe(Effect.asVoid) : Effect.void
      }
      if (frame.id === undefined) return Effect.void
      const { id, method } = frame
      calls.push({ method, params: frame.params })
      const handler = handlers[method]
      const handled = handler ? handler(frame.params) : Effect.fail(rpcFailure(`Unhandled request: ${method}`, -32601))
      const run = options.before ? Effect.andThen(options.before(method, frame.params), handled) : handled
      return run.pipe(
        Effect.matchEffect({
          onSuccess: (result) => connection.send({ id, result }),
          onFailure: (error) => connection.send({ id, error }),
        }),
        Effect.forkIn(connection.scope),
        Effect.asVoid,
      )
    })

  const connect: Connect = Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const { stdio, input, output } = yield* makeInMemoryStdio()
    const connection: Connection = {
      send: (frame) => Queue.offer(input, encoder.encode(`${JSON.stringify(frame)}\n`)).pipe(Effect.asVoid),
      close: Queue.end(input).pipe(Effect.asVoid),
      scope,
      exit: { code: 0 },
    }
    connections += 1
    live = connection
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (live === connection) live = null
      }),
    )
    yield* Stream.fromQueue(output).pipe(
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.runForEach((line) => onFrame(connection, line)),
      Effect.forkScoped,
    )
    return yield* CodexClient.make(
      stdio,
      {},
      Effect.sync(
        () =>
          new CodexError.CodexAppServerProcessExitedError({
            code: connection.exit.code,
            ...(connection.exit.stderr ? { stderr: connection.exit.stderr } : {}),
          }),
      ),
    )
  })

  return {
    connect,
    calls,
    threads,
    connections: () => connections,
    pendingRequests: () => [...answers.keys()],
    notify,
    request: (method, params) =>
      Effect.gen(function* () {
        const connection = live
        if (!connection) return yield* Effect.die(new Error('fake Codex is not connected'))
        const id = (nextServerId += 1)
        const answer = yield* Deferred.make<unknown>()
        answers.set(id, answer)
        yield* connection.send({ id, method, params })
        return yield* Deferred.await(answer).pipe(Effect.ensuring(Effect.sync(() => answers.delete(id))))
      }),
    exit: (code, stderr) =>
      Effect.suspend(() => {
        const connection = live
        if (!connection) return Effect.void
        connection.exit = { code, ...(stderr ? { stderr } : {}) }
        live = null
        return connection.close
      }),
  }
}
