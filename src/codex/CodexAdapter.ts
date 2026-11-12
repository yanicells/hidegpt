import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import { CAPABILITIES } from '../shared/model'
import type { ApprovalReply, DocSummary, Skill } from '../shared/model'
import {
  type BinaryMissingError,
  ProcessExitedError,
  ProviderDefectError,
  ProviderRequestError,
  type ProviderError,
  ProviderTimeoutError,
} from '../provider/errors'
import { logDefects, reportDefect } from '../provider/DefectReport'
import type { ProcessSupervisor } from '../provider/ProcessSupervisor'
import { randomUuidV4 } from '../provider/randomUuid'
import type { Catalog, TurnSettings } from '../provider/ProviderAdapter'
import type {
  LegacyAdapterEvent as AdapterEvent,
  LegacyOpenedThread as OpenedThread,
  LegacyProviderAdapter as ProviderAdapter,
  LegacyProviderSession as ProviderSession,
} from '../provider/legacyEvents'
import * as CodexClient from '../vendor/effect-codex-app-server/client.ts'
import * as CodexError from '../vendor/effect-codex-app-server/errors.ts'
import type * as CodexRpc from '../vendor/effect-codex-app-server/rpc.ts'
import {
  APPROVAL_METHODS,
  APPROVALS,
  type ApprovalMethod,
  blocksFromTurns,
  formatCodexError,
  itemToBlock,
  type McpServer,
  type Project,
  toAccount,
  toDoc,
  toModelOption,
  toProject,
  toReasoningEffort,
  toTool,
} from './mapping'

/**
 * Codex `app-server` (JSON-RPC over stdio) as a `ProviderAdapter`. One process
 * serves every thread. The typed client is vendored from T3 Code
 * (`effect-codex-app-server`); this module maps it onto HideGPT's events and
 * blocks, the way T3's `CodexAdapterV2` maps it onto orchestration events.
 * The wire-to-model mapping itself lives in `./mapping`.
 */

export type Client = CodexClient.CodexAppServerClient['Service']
type Method = CodexRpc.ClientRequestMethod
type Params<M extends Method> = CodexRpc.ClientRequestParamsByMethod[M]
type Result<M extends Method> = CodexRpc.ClientRequestResponsesByMethod[M]
type Notification<M extends CodexRpc.ServerNotificationMethod> = CodexRpc.ServerNotificationParamsByMethod[M]

type Mode = Result<'collaborationMode/list'>['data'][number]
type UserInput = Params<'turn/start'>['input'][number]

/** Opens a connected client in the caller's scope: the real process, or a fake peer in tests and demo mode. */
export type Connect = Effect.Effect<Client, BinaryMissingError | ProviderRequestError, Scope.Scope>

/** Seconds each request may take. Resume replays a whole thread, so it gets the longest. */
const DEADLINES: Partial<Record<Method, number>> = {
  initialize: 20,
  'thread/resume': 90,
  'thread/start': 60,
  'turn/start': 60,
  'thread/turns/list': 60,
}
const DEFAULT_DEADLINE = 30

const INTERACTIVE_SOURCES: Params<'thread/list'>['sourceKinds'] = ['cli', 'vscode', 'appServer']
const PAGE = 30
const DOC_PAGE = 50
const MAX_DOC_PAGES = 20

const signalOf = (error: unknown): string | null =>
  /signal: '([A-Z0-9]+)'/.exec(error instanceof Error ? error.message : String(error))?.[1] ?? null

/** How the connection ended, as the shared error the session manager restarts after. */
export function exitError(error: CodexError.CodexAppServerError): ProcessExitedError {
  if (error._tag === 'CodexAppServerProcessExitedError') {
    return new ProcessExitedError({
      provider: 'codex',
      code: error.code ?? null,
      signal: null,
      ...(error.stderr ? { stderr: error.stderr } : {}),
    })
  }
  const cause = 'cause' in error ? error.cause : undefined
  return new ProcessExitedError({ provider: 'codex', code: null, signal: signalOf(cause) })
}

function requestError(method: string, error: CodexError.CodexAppServerError): ProviderError {
  if (error._tag === 'CodexAppServerRequestError') {
    return new ProviderRequestError({ provider: 'codex', operation: method, detail: formatCodexError(error.message) })
  }
  if (error._tag === 'CodexAppServerProtocolParseError') {
    return new ProviderRequestError({
      provider: 'codex',
      operation: method,
      detail: `Codex sent an unexpected reply to ${method}.`,
    })
  }
  return exitError(error)
}

/** A typed request with its deadline; failures become HideGPT's tagged errors. */
export const call =
  (client: Client) =>
  <M extends Method>(method: M, params: Params<M>): Effect.Effect<Result<M>, ProviderError> => {
    const seconds = DEADLINES[method] ?? DEFAULT_DEADLINE
    return client.request(method, params).pipe(
      Effect.mapError((error) => requestError(method, error)),
      Effect.timeoutOrElse({
        duration: Duration.seconds(seconds),
        orElse: () => Effect.fail(new ProviderTimeoutError({ provider: 'codex', operation: method, seconds })),
      }),
    )
  }

type PendingApproval = {
  readonly threadId: string
  readonly answer: Deferred.Deferred<ApprovalReply>
}

/** Builds the adapter over a way to connect (the spawned process by default). */
export function make(connect: Connect): ProviderAdapter {
  return {
    id: 'codex',
    capabilities: CAPABILITIES.codex,
    openSession: Effect.gen(function* () {
      const client = yield* connect
      const services = yield* Effect.context<never>()
      const rpc = call(client)
      const events = yield* Queue.unbounded<AdapterEvent>()
      yield* Effect.addFinalizer(() => Queue.shutdown(events))
      const emit = (event: AdapterEvent) => Queue.offer(events, event).pipe(Effect.asVoid)
      // Off-path calls (elicitation counters, token refresh) must never fail a handler.
      const scope = yield* Scope.Scope
      const background = <A>(effect: Effect.Effect<A, ProviderError>) =>
        Effect.asVoid(Effect.forkIn(logDefects(Effect.ignore(effect)), scope))

      /** Threads this connection resumed or started (server-side subscriptions). */
      const loaded = new Set<string>()
      /** The running turn per thread; `turn/interrupt` needs its id. */
      const activeTurns = new Map<string, string>()
      const approvals = new Map<string, PendingApproval>()
      let modes: ReadonlyArray<Mode> = []

      // The vendored dispatch handles a handler's failure but not its die: a notification
      // reader would end silently, and a request would never be answered, leaving the turn
      // hanging. A die is a Docs bug, so it is reported and ends the session here; the
      // manager restarts it with a plain banner.
      const defect = yield* Deferred.make<never, ProviderError>()
      const endOnDefect = (cause: Cause.Cause<unknown>) =>
        reportDefect(cause).pipe(
          Effect.flatMap((reportId) => Deferred.fail(defect, new ProviderDefectError({ provider: 'codex', reportId }))),
          Effect.asVoid,
        )
      yield* registerNotifications(client, emit, { loaded, activeTurns, endOnDefect })

      /**
       * `client.handleServerRequest`, with a die reported and the session ended. The error
       * reply is only for the types: the connection closes, and the restarted Codex starts over.
       *
       * Why restart rather than answer `internalError` and carry on: a die is a Docs bug partway
       * through a handler, so Docs' side may be half-updated (an approval block on the page with
       * no pending entry behind it, an elicitation counter raised but never lowered). A restart
       * reloads the document from Codex's own transcript and shows the banner; carrying on would
       * leave the page out of step with Codex and say nothing.
       */
      const handle = <M extends CodexRpc.ServerRequestMethod>(
        method: M,
        handler: (
          params: CodexRpc.ServerRequestParamsByMethod[M],
        ) => Effect.Effect<CodexRpc.ServerRequestResponsesByMethod[M], CodexError.CodexAppServerError>,
      ) =>
        client.handleServerRequest(method, (params) =>
          Effect.suspend(() => handler(params)).pipe(
            Effect.catchCauseIf(Cause.hasDies, (cause) =>
              endOnDefect(cause).pipe(
                Effect.andThen(
                  Effect.fail(
                    CodexError.CodexAppServerRequestError.internalError('Docs could not handle this request.'),
                  ),
                ),
              ),
            ),
          ),
        )

      yield* handle('currentTime/read', () =>
        Effect.map(Clock.currentTimeMillis, (millis) => ({ currentTimeAt: Math.floor(millis / 1000) })),
      )
      yield* handle('item/tool/call', () =>
        Effect.succeed({
          contentItems: [{ type: 'inputText' as const, text: 'This Docs window does not host that tool.' }],
          success: false,
        }),
      )
      yield* handle('attestation/generate', () =>
        Effect.fail(CodexError.CodexAppServerRequestError.internalError('attestation is not enabled')),
      )
      // Codex only asks for tokens a client supplied itself; Docs signs in through Codex's own
      // ChatGPT login, which Codex refreshes, so this should never come. If it does, sign in again.
      yield* handle('account/chatgptAuthTokens/refresh', () =>
        Effect.gen(function* () {
          yield* emit({ type: 'notice', message: 'Sign in with ChatGPT to refresh this session.' })
          yield* emit({ type: 'invalidate', part: 'account' })
          return yield* Effect.fail(
            CodexError.CodexAppServerRequestError.internalError('Codex-managed ChatGPT auth has no refreshable tokens'),
          )
        }),
      )

      // An approval holds its request open on a Deferred until the person answers. Codex
      // settles it itself (`serverRequest/resolved`) when the turn ends; the vendored
      // protocol then interrupts this fiber, and the block shows as skipped.
      const awaitApproval =
        <M extends ApprovalMethod>(method: M) =>
        (params: CodexRpc.ServerRequestParamsByMethod[M]) =>
          Effect.gen(function* () {
            const spec = APPROVALS[method]
            const threadId = spec.threadId(params)
            const blockId = `approval-${yield* randomUuidV4}`
            const answer = yield* Deferred.make<ApprovalReply>()
            approvals.set(blockId, { threadId, answer })
            yield* emit({ type: 'block', threadId, block: spec.block(blockId, params) })
            const elicitation = method === 'mcpServer/elicitation/request'
            if (elicitation) {
              yield* background(rpc('thread/increment_elicitation', { threadId }))
              const request = params as CodexRpc.ServerRequestParamsByMethod['mcpServer/elicitation/request']
              if (request.mode === 'url') yield* emit({ type: 'loginUrl', url: request.url })
            }
            const reply = yield* Deferred.await(answer).pipe(
              Effect.onInterrupt(() => emit({ type: 'resolved', threadId, blockId, resolved: 'skipped' })),
              Effect.ensuring(Effect.sync(() => approvals.delete(blockId))),
            )
            if (elicitation) yield* background(rpc('thread/decrement_elicitation', { threadId }))
            return spec.response(params, reply)
          })
      const handleApproval = <M extends ApprovalMethod>(method: M) => handle(method, awaitApproval(method))
      yield* Effect.forEach(APPROVAL_METHODS, handleApproval, { discard: true })

      yield* rpc('initialize', {
        clientInfo: { name: 'hidegpt', title: 'Docs', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
      yield* client
        .notify('initialized', undefined)
        .pipe(Effect.mapError((error) => requestError('initialized', error)))

      const listProjects = Effect.gen(function* () {
        const projects: Project[] = []
        let cursor: string | null = null
        do {
          const page: Result<'project/list'> = yield* rpc('project/list', { limit: 100, cursor, sortKey: 'recencyAt' })
          projects.push(...page.data)
          cursor = page.nextCursor ?? null
        } while (cursor)
        return projects
      })

      const turnOverrides = (settings: TurnSettings) => {
        const preset = modes.find((item) => item.name === settings.mode)
        if (preset?.mode) {
          return {
            collaborationMode: {
              mode: preset.mode,
              settings: {
                model: preset.model ?? settings.model ?? '',
                reasoning_effort: preset.reasoning_effort ?? null,
                developer_instructions: null,
              },
            },
            serviceTierForTurn: settings.serviceTier,
          }
        }
        // Null inherits the thread's tier; a tier id applies to this turn only.
        return {
          model: settings.model,
          effort: toReasoningEffort(settings.effort),
          serviceTierForTurn: settings.serviceTier,
        }
      }

      const session: ProviderSession = {
        events: Stream.fromQueue(events),
        awaitExit: client.awaitTermination.pipe(Effect.mapError(exitError), Effect.raceFirst(Deferred.await(defect))),

        loadCatalog: Effect.gen(function* () {
          const [account, models, projects, modeList, tools] = yield* Effect.all(
            [
              rpc('account/read', { refreshToken: false }),
              rpc('model/list', {}),
              Effect.option(listProjects),
              rpc('collaborationMode/list', {}).pipe(Effect.orElseSucceed(() => ({ data: [] as Mode[] }))),
              rpc('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }).pipe(
                Effect.orElseSucceed(() => ({ data: [] as McpServer[] })),
              ),
            ],
            { concurrency: 'unbounded' },
          )
          const visible = models.data.filter((model) => !model.hidden)
          modes = modeList.data.filter((mode) => mode.mode !== 'plan' && mode.name.toLowerCase() !== 'plan')
          return {
            account: toAccount(account.account),
            requiresAuth: account.account == null,
            models: (visible.length ? visible : models.data).map(toModelOption),
            modes: modes.map((mode) => ({ id: mode.name, label: mode.name })),
            defaultMode: modes[0]?.name ?? null,
            projects: Option.getOrElse(
              Option.map(projects, (list) => list.map(toProject)),
              () => [],
            ),
            tools: tools.data.map(toTool),
          } satisfies Catalog
        }),

        listDocs: (search) =>
          Stream.paginate({ cursor: null as string | null, page: 0 }, ({ cursor, page }) =>
            rpc('thread/list', {
              cursor,
              limit: DOC_PAGE,
              sortKey: 'updated_at',
              sourceKinds: INTERACTIVE_SOURCES,
              searchTerm: search.trim() || null,
            }).pipe(
              Effect.map((listed) => {
                const next =
                  listed.nextCursor && page + 1 < MAX_DOC_PAGES
                    ? Option.some({ cursor: listed.nextCursor, page: page + 1 })
                    : Option.none()
                return [[listed.data.map(toDoc)], next] as const
              }),
            ),
          ).pipe(
            Stream.scan(
              (): ReadonlyArray<DocSummary> => [],
              (all, page: ReadonlyArray<DocSummary>) => [...all, ...page],
            ),
            Stream.drop(1),
          ),

        listSkills: (cwd) =>
          rpc('skills/list', { cwds: cwd ? [cwd] : [], forceReload: false }).pipe(
            Effect.map((listed) => {
              const skills = new Map<string, Skill>()
              for (const entry of listed.data) {
                for (const skill of entry.skills) {
                  if (!skill.enabled || skills.has(skill.name)) continue
                  skills.set(skill.name, {
                    name: skill.name,
                    description: skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description,
                    path: skill.path,
                  })
                }
              }
              return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
            }),
          ),

        openThread: (threadId) =>
          Effect.gen(function* () {
            const resumed = yield* rpc('thread/resume', {
              threadId,
              excludeTurns: true,
              initialTurnsPage: { limit: PAGE, sortDirection: 'desc', itemsView: 'full' },
            })
            const id = resumed.thread.id
            loaded.add(id)
            const page =
              resumed.initialTurnsPage ??
              (yield* Effect.option(
                rpc('thread/turns/list', { threadId: id, limit: PAGE, sortDirection: 'desc', itemsView: 'full' }),
              ).pipe(Effect.map(Option.getOrNull)))
            const running = page?.data.find((turn) => turn.status === 'inProgress')
            if (running) activeTurns.set(id, running.id)
            return {
              threadId: id,
              title: resumed.thread.name?.trim() || resumed.thread.preview?.trim() || 'Untitled document',
              blocks: blocksFromTurns([...(page?.data ?? [])].reverse()),
              olderCursor: page?.backwardsCursor ?? resumed.turnsBackwardsCursor ?? null,
              cwd: resumed.cwd,
              settings: {
                model: resumed.model || null,
                effort: resumed.reasoningEffort ?? null,
                serviceTier: resumed.serviceTier ?? null,
              },
              streaming: resumed.thread.status.type === 'active',
            } satisfies OpenedThread
          }),

        createThread: (options) =>
          Effect.gen(function* () {
            const started = yield* rpc('thread/start', {
              cwd: options.cwd,
              projectId: options.projectId,
              model: options.settings.model,
              serviceTier: options.settings.serviceTier,
            })
            const id = started.thread.id
            loaded.add(id)
            if (options.title) yield* Effect.ignore(rpc('thread/name/set', { threadId: id, name: options.title }))
            return {
              threadId: id,
              title: options.title || 'Untitled document',
              blocks: [],
              olderCursor: null,
              cwd: started.cwd,
              settings: {
                model: started.model || null,
                effort: started.reasoningEffort ?? null,
                serviceTier: started.serviceTier ?? null,
              },
            } satisfies OpenedThread
          }),

        loadOlder: (threadId, cursor) =>
          rpc('thread/turns/list', { threadId, cursor, limit: PAGE, sortDirection: 'desc', itemsView: 'full' }).pipe(
            Effect.map((page) => ({
              blocks: blocksFromTurns([...page.data].reverse()),
              cursor: page.backwardsCursor ?? null,
            })),
          ),

        // Sync by contract, so it runs on the session's services (a seeded `Random` in tests).
        messageId: () => `local-${Effect.runSyncWith(services)(randomUuidV4)}`,

        send: (threadId, input, settings) =>
          Effect.gen(function* () {
            // A thread the server unloaded (or this connection never resumed) resumes first.
            if (!loaded.has(threadId)) {
              yield* rpc('thread/resume', { threadId, excludeTurns: true })
              loaded.add(threadId)
            }
            const items: UserInput[] = [
              ...(input.text ? [{ type: 'text' as const, text: input.text, text_elements: [] }] : []),
              ...input.images.map((path) => ({ type: 'localImage' as const, path })),
              ...(input.skill ? [{ type: 'skill' as const, name: input.skill.name, path: input.skill.path }] : []),
            ]
            const started = yield* rpc('turn/start', {
              threadId,
              input: items,
              clientUserMessageId: input.clientId,
              ...turnOverrides(settings),
            })
            activeTurns.set(threadId, started.turn.id)
          }),

        interrupt: (threadId) =>
          Effect.suspend(() => {
            const turnId = activeTurns.get(threadId)
            return turnId
              ? Effect.asVoid(rpc('turn/interrupt', { threadId, turnId }))
              : Effect.fail(
                  new ProviderRequestError({
                    provider: 'codex',
                    operation: 'turn/interrupt',
                    detail: 'Nothing is running in this document.',
                  }),
                )
          }),

        respond: (_threadId, approvalId, reply) =>
          Effect.gen(function* () {
            const pending = approvals.get(approvalId)
            const taken = pending ? yield* Deferred.succeed(pending.answer, reply) : false
            if (!taken) {
              return yield* Effect.fail(
                new ProviderRequestError({
                  provider: 'codex',
                  operation: 'respond',
                  detail: 'This request is no longer waiting for an answer.',
                }),
              )
            }
          }),

        rename: (threadId, name) => Effect.asVoid(rpc('thread/name/set', { threadId, name })),

        releaseThread: (threadId) =>
          Effect.suspend(() =>
            loaded.delete(threadId) ? Effect.ignore(rpc('thread/unsubscribe', { threadId })) : Effect.void,
          ),

        createProject: (name, cwd) =>
          randomUuidV4.pipe(
            Effect.flatMap((idempotencyKey) => rpc('project/create', { name, roots: [{ path: cwd }], idempotencyKey })),
            Effect.asVoid,
          ),

        login: rpc('account/login/start', { type: 'chatgpt', appBrand: 'chatgpt' }).pipe(
          Effect.flatMap((result) =>
            result.type === 'chatgpt'
              ? Effect.succeed(result.authUrl)
              : Effect.fail(
                  new ProviderRequestError({
                    provider: 'codex',
                    operation: 'login',
                    detail: 'This sign-in method is not supported in Docs.',
                  }),
                ),
          ),
        ),

        logout: Effect.asVoid(rpc('account/logout', undefined)),

        connectTool: (name) =>
          rpc('mcpServer/oauth/login', { name }).pipe(Effect.map((result) => result.authorizationUrl)),
      }
      return session
    }),
  }
}

/** Codex notifications as adapter events. Every thread event names its thread; the manager routes it. */
function registerNotifications(
  client: Client,
  emit: (event: AdapterEvent) => Effect.Effect<void>,
  {
    loaded,
    activeTurns,
    endOnDefect,
  }: {
    readonly loaded: Set<string>
    readonly activeTurns: Map<string, string>
    readonly endOnDefect: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
  },
) {
  // A die here would end the vendored reader silently and leave the page waiting.
  const on = <M extends CodexRpc.ServerNotificationMethod>(
    method: M,
    toEvents: (params: Notification<M>) => ReadonlyArray<AdapterEvent>,
  ) =>
    client.handleServerNotification(method, (params) =>
      Effect.suspend(() => Effect.forEach(toEvents(params), emit, { discard: true })).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => endOnDefect(cause),
        ),
      ),
    )

  const docsChanged = { type: 'invalidate', part: 'docs' } as const
  return Effect.all(
    [
      on('item/agentMessage/delta', (p) => [
        { type: 'text', threadId: p.threadId, blockId: p.itemId, delta: p.delta, create: { kind: 'agent' } },
      ]),
      on('item/commandExecution/outputDelta', (p) => [
        {
          type: 'text',
          threadId: p.threadId,
          blockId: p.itemId,
          delta: p.delta,
          create: { kind: 'callout', title: 'Running a command' },
        },
      ]),
      on('turn/diff/updated', (p) => [
        {
          type: 'block',
          threadId: p.threadId,
          block: { kind: 'callout', id: `diff-${p.turnId}`, title: 'Changes', body: p.diff },
        },
      ]),
      on('item/started', (p) => {
        const block = itemToBlock(p.item)
        // An agent message starts empty and grows by deltas; only its completed text replaces them.
        if (!block || (block.kind === 'agent' && !block.text)) return []
        return [
          {
            type: 'block',
            threadId: p.threadId,
            block,
            replaces: p.item.type === 'userMessage' ? p.item.clientId : null,
          },
        ]
      }),
      on('item/completed', (p) => {
        const block = itemToBlock(p.item)
        if (!block) return []
        return [
          {
            type: 'block',
            threadId: p.threadId,
            block,
            replaces: p.item.type === 'userMessage' ? p.item.clientId : null,
          },
        ]
      }),
      on('turn/started', (p) => {
        activeTurns.set(p.threadId, p.turn.id)
        return [{ type: 'turnStarted', threadId: p.threadId }]
      }),
      on('turn/completed', (p) => {
        if (activeTurns.get(p.threadId) === p.turn.id) activeTurns.delete(p.threadId)
        return [
          {
            type: 'turnEnded',
            threadId: p.threadId,
            ...(p.turn.status === 'failed' && p.turn.error ? { error: p.turn.error.message } : {}),
          },
        ]
      }),
      on('error', (p) =>
        p.willRetry
          ? [{ type: 'notice', message: p.error.message }]
          : [{ type: 'turnEnded', threadId: p.threadId, error: p.error.message }],
      ),
      on('warning', (p) => (p.message ? [{ type: 'notice', message: p.message }] : [])),
      on('guardianWarning', (p) => (p.message ? [{ type: 'notice', message: p.message }] : [])),
      on('configWarning', (p) => (p.summary ? [{ type: 'notice', message: p.summary }] : [])),
      on('thread/name/updated', (p) =>
        p.threadName ? [{ type: 'title', threadId: p.threadId, title: p.threadName }] : [],
      ),
      // The server unloaded the thread; the next send resumes it.
      on('thread/closed', (p) => {
        loaded.delete(p.threadId)
        return []
      }),
      on('thread/deleted', (p) => {
        loaded.delete(p.threadId)
        return [{ type: 'closed', threadId: p.threadId }, docsChanged]
      }),
      on('thread/archived', (p) => {
        loaded.delete(p.threadId)
        return [{ type: 'closed', threadId: p.threadId }, docsChanged]
      }),
      on('thread/started', () => [docsChanged]),
      on('thread/unarchived', () => [docsChanged]),
      on('account/updated', () => [
        { type: 'loginUrl', url: null },
        { type: 'invalidate', part: 'account' },
      ]),
      on('account/login/completed', () => [
        { type: 'loginUrl', url: null },
        { type: 'invalidate', part: 'account' },
      ]),
      on('skills/changed', () => [{ type: 'invalidate', part: 'skills' }]),
      on('project/changed', () => [{ type: 'invalidate', part: 'projects' }]),
      on('mcpServer/oauthLogin/completed', () => [
        { type: 'loginUrl', url: null },
        { type: 'invalidate', part: 'tools' },
      ]),
    ],
    { discard: true },
  )
}

/**
 * Options for the vendored client. It can log every JSON-RPC frame at Debug,
 * and main's log file keeps Debug lines, but frames hold prompts and answers.
 * Never turn these on.
 */
export const CLIENT_OPTIONS = {
  logIncoming: false,
  logOutgoing: false,
} as const satisfies CodexClient.CodexAppServerClientOptions

/** The real backend: `codex app-server`, spawned under the process supervisor. */
export const spawnAppServer = (supervisor: ProcessSupervisor['Service']): Connect =>
  Effect.gen(function* () {
    const process = yield* supervisor.spawn({
      provider: 'codex',
      command: globalThis.process.env.CODEX_BIN || 'codex',
      args: ['app-server'],
    })
    const context = yield* Layer.build(CodexClient.layerChildProcess(process.handle, CLIENT_OPTIONS))
    return Context.get(context, CodexClient.CodexAppServerClient)
  })
