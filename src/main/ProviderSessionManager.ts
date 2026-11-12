import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FiberHandle from 'effect/FiberHandle'
import * as FiberMap from 'effect/FiberMap'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as SubscriptionRef from 'effect/SubscriptionRef'

import { mergeOlderBlocks, updateApproval } from '../shared/blocks'
import type { Command } from '../shared/contracts'
import { HOME, type ProviderId, type Snapshot, type UserBlock } from '../shared/model'
import {
  CommandRejectedError,
  endsConnection,
  ProcessExitedError,
  type ProviderError,
  ProviderNotReadyError,
  userMessage,
} from '../provider/errors'
import type { AdapterEvent, CatalogPart, OpenedThread, ProviderSession } from '../provider/ProviderAdapter'
import { isThreadEvent } from '../provider/ProviderAdapter'
import { ProviderRegistry } from './ProviderRegistry'
import * as S from './session/state'

/**
 * The one owner of UI state in main (T3 Code's `ProviderSessionManager`,
 * reduced to what a single window needs). It keeps a runtime per open
 * document, so a turn keeps streaming and approvals keep waiting while the
 * window shows Home or another document; it releases idle runtimes, and it
 * restarts a crashed provider with backoff. All state lives in one
 * `SubscriptionRef`; the IPC layer turns its changes into snapshot patches.
 *
 * Concurrency is fibers, not tokens: navigation runs in a `FiberHandle`, so a
 * newer open interrupts a slower one; refreshes, debounced invalidations,
 * stop timers, and connections run in `FiberMap`s keyed by what they update,
 * so a newer run replaces the older one and nothing stale ever lands.
 */

export type ManagerError = ProviderError | CommandRejectedError

export interface ManagerOptions {
  /** Where documents start when nothing else says so. */
  readonly defaultCwd: (provider: ProviderId) => string
  /** Opens sign-in and connect URLs in the system browser. */
  readonly openExternal: (url: string) => Effect.Effect<void>
  readonly idleRelease?: Duration.Input
}

export class ProviderSessionManager extends Context.Service<
  ProviderSessionManager,
  {
    readonly snapshot: Effect.Effect<Snapshot>
    /** The current snapshot, then one per state change. */
    readonly snapshots: Stream.Stream<Snapshot>
    /** Connects the first library. Connection problems land on the banner; this never fails. */
    readonly start: (provider: ProviderId) => Effect.Effect<void>
    readonly dispatch: (command: Exclude<Command, { op: 'openFolder' }>) => Effect.Effect<void, ManagerError>
    /** File → Open folder: where the next document starts. */
    readonly setFolder: (cwd: string) => Effect.Effect<void>
    /** Banner text for failures with no other place to show (menu commands). */
    readonly notify: (message: string) => Effect.Effect<void>
    /** Documents kept in memory (tests and diagnostics). */
    readonly runtimeCount: Effect.Effect<number>
  }
>()('hidegpt/ProviderSessionManager') {}

/** 500 ms, doubling to at most 10 s, six times. A session that stayed up 60 s starts the count over. */
export const RESTART_SCHEDULE = Schedule.exponential('500 millis').pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(10)))),
  Schedule.upTo({ times: 6 }),
)
const STABLE_AFTER = Duration.seconds(60)
const READY_DEADLINE = Duration.seconds(45)
const STOP_SETTLE = Duration.seconds(10)
const INVALIDATE_DEBOUNCE = Duration.millis(400)
const SWEEP_EVERY = Duration.seconds(60)
const MAX_IDLE_RUNTIMES = 12
export const IDLE_RELEASE = Duration.minutes(30)

/** Interruption means a newer navigation took over: the command still succeeded. */
const joinSuperseded = <A, E>(fiber: Fiber.Fiber<A, E>): Effect.Effect<void, E> =>
  Fiber.await(fiber).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? Effect.void : Effect.failCause(exit.cause),
    ),
  )

const rejected = (reason: string) => Effect.fail(new CommandRejectedError({ reason }))

function signInElsewhere(provider: ProviderId): string {
  return provider === 'opencode'
    ? 'OpenCode signs in outside Docs — run `opencode auth login` in a terminal, then Refresh.'
    : 'Claude signs in outside Docs — run `claude` in a terminal and log in, then Tools → Refresh.'
}

export const make = (options: ManagerOptions) =>
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry
    /** The layer's scope: background work started by commands outlives the command. */
    const scope = yield* Scope.Scope
    const background = <E>(effect: Effect.Effect<void, E>) => Effect.asVoid(Effect.forkIn(Effect.ignore(effect), scope))
    const idleMs = Duration.toMillis(Duration.fromInputUnsafe(options.idleRelease ?? IDLE_RELEASE))
    const state = yield* SubscriptionRef.make(S.initialState('codex', options.defaultCwd))
    /** Live sessions by provider; set while a connection is up. */
    const sessions = new Map<ProviderId, ProviderSession>()

    const connections = yield* FiberMap.make<ProviderId>()
    const navigation = yield* FiberHandle.make()
    const refreshes = yield* FiberMap.make<string>()
    const invalidations = yield* FiberMap.make<string>()
    const stopTimers = yield* FiberMap.make<string>()

    const read = SubscriptionRef.get(state)
    const update = (f: (state: S.State) => S.State) => SubscriptionRef.update(state, f)
    const updateLibrary = (id: ProviderId, f: (lib: S.Library) => S.Library) =>
      update((current) => S.updateLibrary(current, id, f))
    const setError = (id: ProviderId, error: string | null) => updateLibrary(id, (lib) => ({ ...lib, error }))
    const active = Effect.map(read, (current) => current.active)
    const now = Clock.currentTimeMillis

    // ---- connections ---------------------------------------------------------

    /** Waits until the provider is connected, starting it if needed. */
    const ready = (id: ProviderId): Effect.Effect<ProviderSession, ProviderNotReadyError> =>
      Effect.gen(function* () {
        yield* ensureConnection(id)
        const lib = yield* SubscriptionRef.changes(state).pipe(
          Stream.map((current) => current.libraries[id]),
          Stream.filter((lib) => lib.status === 'error' || (lib.status === 'ready' && sessions.has(id))),
          Stream.runHead,
          Effect.timeoutOrElse({ duration: READY_DEADLINE, orElse: () => Effect.succeed(Option.none()) }),
        )
        const session = sessions.get(id)
        if (Option.isSome(lib) && lib.value.status === 'ready' && session) return session
        return yield* Effect.fail(
          new ProviderNotReadyError({ provider: id, detail: Option.isSome(lib) ? lib.value.error : null }),
        )
      })

    const ensureConnection = (id: ProviderId) =>
      Effect.gen(function* () {
        if (yield* FiberMap.has(connections, id)) return
        yield* updateLibrary(id, (lib) => ({ ...lib, status: 'connecting' }))
        yield* FiberMap.run(connections, id, supervise(id), { onlyIfMissing: true })
      })

    /** One session's life: open, report ready, reload, then wait for the process to end. */
    const connectOnce = (id: ProviderId) =>
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* registry.adapter(id)
          const session = yield* adapter.openSession
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => sessions.delete(id)).pipe(
              // Refreshes run outside this scope; stop the ones still talking to the dead session.
              Effect.andThen(Effect.forEach(['all', 'docs', 'skills', 'catalog'], (part) => FiberMap.remove(refreshes, `${id}:${part}`), { discard: true })),
            ),
          )
          // A defect while applying an event ends the session like a crash, so it restarts
          // instead of looking connected but frozen.
          // Adapted from T3 Code (packages/provider-opencode/src/server/adapter.ts) at commit 8a14762c.
          // Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
          const pump = yield* session.events.pipe(
            Stream.runForEach(onEvent(id)),
            Effect.andThen(Effect.never),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.fail(
                    new ProcessExitedError({ provider: id, code: null, signal: null, stderr: userMessage(Cause.squash(cause)) }),
                  ),
            ),
            Effect.forkScoped,
          )
          sessions.set(id, session)
          const startedAt = yield* now
          yield* updateLibrary(id, (lib) => ({ ...lib, status: 'ready', error: null }))
          yield* Effect.forkScoped(Effect.all([refreshCatalog(id), reloadDisplayed(id, session)], { concurrency: 'unbounded', discard: true }))
          return yield* session.awaitExit.pipe(
            Effect.raceFirst(Fiber.join(pump)),
            // A session that ran a while ends "successfully", so the restart count starts over.
            Effect.catch((error) =>
              Effect.flatMap(now, (at) =>
                at - startedAt >= Duration.toMillis(STABLE_AFTER) ? Effect.succeed(error) : Effect.fail(error),
              ),
            ),
          )
        }),
      )

    const supervise = (id: ProviderId) =>
      connectOnce(id).pipe(
        Effect.tapError((error) => update((current) => S.connectionLost(current, id, error.message))),
        // Only a dead or wedged process is worth restarting; a missing binary or a bad config is not.
        Effect.retry({ schedule: RESTART_SCHEDULE, while: endsConnection }),
        Effect.tap((error) => update((current) => S.connectionLost(current, id, error.message))),
        Effect.forever,
        // Anything else, a defect included, leaves the library in error; the next command or
        // library switch connects it again. The shown document is marked stale either way.
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt
          const error = userMessage(Cause.squash(cause))
          // One update, so no snapshot shows the library reconnecting first.
          return update((current) =>
            S.updateLibrary(S.connectionLost(current, id, error), id, (lib) => ({ ...lib, status: 'error', error, opening: null })),
          )
        }),
      )

    /** After a (re)connect the document on screen reloads from the provider. */
    const reloadDisplayed = (id: ProviderId, session: ProviderSession) =>
      Effect.gen(function* () {
        const current = yield* read
        const route = current.libraries[id].route
        if (route.kind !== 'doc') return
        const runtime = current.runtimes.get(S.keyOf(id, route.threadId))
        if (runtime && !runtime.stale) return
        const opened = yield* session.openThread(route.threadId)
        const at = yield* now
        yield* update((latest) => S.adopt(latest, id, opened, at))
      }).pipe(Effect.catch((error) => setError(id, error.message)))

    // ---- catalog ---------------------------------------------------------------

    /** Runs `effect` as the only refresh of its kind; a newer one interrupts it. */
    const refreshing = <E>(id: ProviderId, part: string, effect: Effect.Effect<void, E>) =>
      FiberMap.run(refreshes, `${id}:${part}`, effect)

    const refreshDocs = (id: ProviderId) =>
      Effect.gen(function* () {
        const session = sessions.get(id)
        if (!session) return
        const lib = (yield* read).libraries[id]
        // Home paints the first page when it is empty; later pages land together.
        const listing = session.listDocs(lib.search)
        const pages = lib.docs.length === 0 ? listing : Stream.takeRight(listing, 1)
        yield* pages.pipe(
          Stream.runForEach((docs) => updateLibrary(id, (latest) => ({ ...latest, docs }))),
          Effect.catch((error) => setError(id, error.message)),
        )
      })

    const refreshSkills = (id: ProviderId, cwd: string, force = false) =>
      Effect.gen(function* () {
        const session = sessions.get(id)
        const lib = (yield* read).libraries[id]
        if (!session || (!force && lib.skillsCwd === cwd)) return
        yield* updateLibrary(id, (latest) => ({ ...latest, skillsCwd: cwd }))
        // Skills are optional; on failure the composer just offers none.
        const skills = yield* Effect.orElseSucceed(session.listSkills(cwd), () => null)
        if (skills) yield* updateLibrary(id, (latest) => ({ ...latest, skills }))
      })

    const skillsCwd = (current: S.State, id: ProviderId) =>
      S.displayedRuntime(current, id)?.cwd ?? current.libraries[id].cwd

    const refreshCatalog = (id: ProviderId) =>
      Effect.gen(function* () {
        const session = sessions.get(id)
        if (!session) return
        const cwd = skillsCwd(yield* read, id)
        const docs = yield* refreshing(id, 'docs', refreshDocs(id))
        const skills = yield* refreshing(id, 'skills', refreshSkills(id, cwd, true))
        const catalog = yield* refreshing(
          id,
          'catalog',
          session.loadCatalog.pipe(
            Effect.flatMap((loaded) => updateLibrary(id, (lib) => S.applyDefaults({ ...lib, catalog: loaded }))),
            Effect.catch((error) => setError(id, error.message)),
          ),
        )
        yield* Effect.forEach([docs, skills, catalog], joinSuperseded, { discard: true })
      })

    /**
     * Debounced: a burst of invalidations becomes one refresh. The debounce only
     * starts the refresh (each runs in `refreshes`), so an invalidation that
     * arrives while one is running schedules another instead of being dropped.
     */
    const invalidate = (id: ProviderId, part: CatalogPart) =>
      FiberMap.run(
        invalidations,
        `${id}:${part}`,
        Effect.sleep(INVALIDATE_DEBOUNCE).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if (part === 'docs') yield* refreshing(id, 'docs', refreshDocs(id))
              else if (part === 'skills') yield* refreshing(id, 'skills', refreshSkills(id, skillsCwd(yield* read, id), true))
              else yield* refreshing(id, 'all', refreshCatalog(id))
            }),
          ),
        ),
        { onlyIfMissing: true },
      ).pipe(Effect.asVoid)

    // ---- adapter events --------------------------------------------------------

    const onEvent =
      (id: ProviderId) =>
      (event: AdapterEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (isThreadEvent(event)) {
            const key = S.keyOf(id, event.threadId)
            const known = (yield* read).runtimes.has(key)
            const at = yield* now
            if (known) yield* update((current) => S.applyThreadEvent(current, id, event, at))
            // A stop timer belongs to one turn: a new turn (say, after a crash ended the stopped one
          // silently) must not be settled by it.
          if (event.type === 'turnStarted' || event.type === 'turnEnded' || event.type === 'closed') {
            yield* FiberMap.remove(stopTimers, key)
          }
            // A thread with no runtime (released, never opened here) only moves Home's ordering.
            if (event.type === 'turnEnded' || (!known && event.type === 'title')) yield* invalidate(id, 'docs')
            return
          }
          switch (event.type) {
            case 'invalidate':
              return yield* invalidate(id, event.part)
            case 'notice':
              return yield* setError(id, event.message)
            case 'loginUrl':
              yield* updateLibrary(id, (lib) => ({ ...lib, loginUrl: event.url }))
              if (event.url) yield* options.openExternal(event.url)
              return
          }
        })

    // ---- idle release ------------------------------------------------------------

    const release = (runtime: S.ThreadRuntime) =>
      Effect.gen(function* () {
        yield* update((current) => S.removeRuntime(current, S.keyOf(runtime.provider, runtime.threadId)))
        const session = sessions.get(runtime.provider)
        if (session) yield* session.releaseThread(runtime.threadId)
      })

    const sweep = Effect.gen(function* () {
      const idle = S.idleRuntimes(yield* read, yield* now, idleMs, MAX_IDLE_RUNTIMES)
      yield* Effect.forEach(idle, release, { discard: true })
    })
    yield* Effect.forkScoped(Effect.repeat(sweep, Schedule.spaced(SWEEP_EVERY)))

    // ---- commands -------------------------------------------------------------------

    const touchDisplayed = (id: ProviderId) =>
      Effect.gen(function* () {
        const runtime = S.displayedRuntime(yield* read, id)
        if (!runtime) return
        const at = yield* now
        yield* update((current) => S.updateRuntime(current, S.keyOf(id, runtime.threadId), (item) => ({ ...item, touchedAt: at })))
      })

    const goHome = (id: ProviderId) =>
      Effect.gen(function* () {
        yield* FiberHandle.clear(navigation)
        yield* touchDisplayed(id)
        yield* updateLibrary(id, (lib) => ({ ...lib, route: HOME, opening: null }))
      })

    /** Runs a navigation; starting another one (or going Home) interrupts it. */
    const navigate = <E>(effect: Effect.Effect<void, E>) =>
      FiberHandle.run(navigation, effect).pipe(Effect.flatMap(joinSuperseded))

    const displayedOrReject = Effect.gen(function* () {
      const current = yield* read
      const runtime = S.displayedRuntime(current)
      return runtime ? runtime : yield* rejected('Open a document first.')
    })

    const showOpened = (id: ProviderId, opened: OpenedThread) =>
      Effect.gen(function* () {
        const at = yield* now
        yield* update((current) => {
          const adopted = S.adopt(current, id, opened, at)
          const shown = S.showThread(adopted, id, opened.threadId)
          return S.updateLibrary(shown, id, (lib) => ({ ...lib, settings: S.adoptSettings(lib.settings, opened.settings) }))
        })
        yield* background(refreshing(id, 'skills', refreshSkills(id, opened.cwd)))
      })

    const openThread = (id: ProviderId, threadId: string) =>
      Effect.gen(function* () {
        yield* touchDisplayed(id)
        const cached = (yield* read).runtimes.get(S.keyOf(id, threadId))
        if (cached && !cached.stale) {
          // Reopening is instant: the runtime kept streaming while the window was elsewhere.
          yield* FiberHandle.clear(navigation)
          const at = yield* now
          yield* update((current) =>
            S.showThread(S.updateRuntime(current, S.keyOf(id, threadId), (item) => ({ ...item, touchedAt: at })), id, threadId),
          )
          yield* refreshing(id, 'skills', refreshSkills(id, cached.cwd))
          return
        }
        yield* updateLibrary(id, (lib) => ({ ...lib, opening: threadId, error: null }))
        yield* navigate(
          Effect.gen(function* () {
            const session = yield* ready(id)
            const hint = (yield* read).libraries[id].docs.find((doc) => doc.id === threadId)
            const opened = yield* session.openThread(threadId, hint)
            yield* showOpened(id, opened)
          }).pipe(
            Effect.tapError((error) => updateLibrary(id, (lib) => ({ ...lib, opening: null, error: error.message }))),
            Effect.onInterrupt(() =>
              updateLibrary(id, (lib) => (lib.opening === threadId ? { ...lib, opening: null } : lib)),
            ),
          ),
        )
      })

    const newDocument = (id: ProviderId, request: Extract<Command, { op: 'newDocument' }>) =>
      navigate(
        Effect.gen(function* () {
          const session = yield* ready(id)
          const current = yield* read
          const fromDialog = request.projectId !== undefined || request.cwd !== undefined || request.title !== undefined
          const cwd =
            request.cwd ?? (fromDialog ? options.defaultCwd(id) : (S.displayedRuntime(current, id)?.cwd ?? current.libraries[id].cwd))
          const opened = yield* session.createThread({
            cwd,
            projectId: request.projectId ?? null,
            title: request.title?.trim() || null,
            settings: current.libraries[id].settings,
          })
          yield* touchDisplayed(id)
          yield* showOpened(id, opened)
          yield* invalidate(id, 'docs')
        }),
      )

    const send = (id: ProviderId, command: Extract<Command, { op: 'send' }>) =>
      Effect.gen(function* () {
        const runtime = yield* displayedOrReject
        if (runtime.streaming) return yield* rejected('Wait for the current answer to finish, or stop it first.')
        const text = command.text.trim()
        const images = command.images ?? []
        const lib = (yield* read).libraries[id]
        const skill = command.skill ? (lib.skills.find((item) => item.name === command.skill) ?? null) : null
        if (!text && images.length === 0 && !skill) return yield* rejected('There is nothing to send.')
        const session = yield* ready(id)
        const clientId = session.messageId()
        const echo: UserBlock = {
          kind: 'user',
          id: clientId,
          text,
          ...(images.length ? { images } : {}),
          ...(skill ? { skills: [skill.name] } : {}),
        }
        const key = S.keyOf(id, runtime.threadId)
        const at = yield* now
        yield* update((current) =>
          S.updateLibrary(
            S.updateRuntime(current, key, (item) => ({ ...item, blocks: [...item.blocks, echo], streaming: true, touchedAt: at })),
            id,
            (latest) => ({ ...latest, error: null }),
          ),
        )
        yield* session.send(runtime.threadId, { text, images, skill, clientId }, lib.settings).pipe(
          Effect.tapError(() =>
            update((current) =>
              S.updateRuntime(current, key, (item) => ({
                ...item,
                streaming: false,
                blocks: item.blocks.filter((block) => block.id !== clientId),
              })),
            ),
          ),
        )
      })

    /**
     * Asks the provider to stop. The document shows "Stopping…" until the turn's
     * terminal event, so late deltas never flip it back; after 10 s it settles anyway,
     * which also frees a document whose turn end was lost. A new turn on the document
     * cancels that timer.
     */
    const interrupt = (id: ProviderId) =>
      Effect.gen(function* () {
        const runtime = S.displayedRuntime(yield* read, id)
        const session = sessions.get(id)
        if (!runtime?.streaming || runtime.stopping || !session) return
        const key = S.keyOf(id, runtime.threadId)
        yield* update((current) => S.updateRuntime(current, key, (item) => ({ ...item, stopping: true })))
        yield* FiberMap.run(
          stopTimers,
          key,
          Effect.sleep(STOP_SETTLE).pipe(Effect.andThen(update((current) => S.updateRuntime(current, key, S.settle)))),
          { onlyIfMissing: true },
        )
        // If the provider rejects the stop (it lost track of the turn), the timer still frees the document.
        yield* Effect.ignore(session.interrupt(runtime.threadId))
      })

    const resolveApproval = (id: ProviderId, command: Extract<Command, { op: 'resolveApproval' }>) =>
      Effect.gen(function* () {
        const runtime = yield* displayedOrReject
        const block = runtime.blocks.find((item) => item.id === command.blockId)
        if (!block || block.kind !== 'approval' || block.resolved !== null || block.pending) return
        const session = yield* ready(id)
        const key = S.keyOf(id, runtime.threadId)
        const mark = (change: Parameters<typeof updateApproval>[2]) =>
          update((current) => S.updateRuntime(current, key, (item) => ({ ...item, blocks: updateApproval(item.blocks, command.blockId, change) })))
        yield* mark({ pending: true })
        yield* session.respond(runtime.threadId, command.blockId, { accept: command.accept, answers: command.answers ?? {} }).pipe(
          Effect.tapError(() => mark({ pending: false })),
        )
        yield* mark({ pending: false, resolved: command.accept ? 'accepted' : 'skipped' })
      })

    const loadOlder = (id: ProviderId) =>
      Effect.gen(function* () {
        const runtime = S.displayedRuntime(yield* read, id)
        const session = sessions.get(id)
        if (!runtime?.olderCursor || runtime.loadingOlder || !session) return
        const key = S.keyOf(id, runtime.threadId)
        yield* update((current) => S.updateRuntime(current, key, (item) => ({ ...item, loadingOlder: true })))
        const page = yield* session.loadOlder(runtime.threadId, runtime.olderCursor).pipe(
          Effect.ensuring(update((current) => S.updateRuntime(current, key, (item) => ({ ...item, loadingOlder: false })))),
        )
        yield* update((current) =>
          S.updateRuntime(current, key, (item) => ({
            ...item,
            blocks: mergeOlderBlocks(page.blocks, item.blocks),
            olderCursor: page.cursor,
          })),
        )
      })

    const rename = (id: ProviderId, name: string) =>
      Effect.gen(function* () {
        const runtime = yield* displayedOrReject
        const trimmed = name.trim()
        if (!trimmed || trimmed === runtime.title) return
        const session = yield* ready(id)
        yield* session.rename(runtime.threadId, trimmed)
        yield* update((current) =>
          S.renameDoc(
            S.updateRuntime(current, S.keyOf(id, runtime.threadId), (item) => ({ ...item, title: trimmed })),
            id,
            runtime.threadId,
            trimmed,
          ),
        )
      })

    const createProject = (id: ProviderId, name: string, cwd: string) =>
      Effect.gen(function* () {
        const session = yield* ready(id)
        if (!session.createProject) {
          return yield* rejected('This library files documents by folder. Choose a folder when you create a document.')
        }
        yield* session.createProject(name.trim(), cwd)
        // The New document dialog reads the project right after this resolves.
        const catalog = yield* session.loadCatalog
        yield* updateLibrary(id, (lib) => ({ ...lib, catalog: { ...lib.catalog, projects: catalog.projects } }))
      })

    const refresh = (id: ProviderId) =>
      Effect.gen(function* () {
        const lib = (yield* read).libraries[id]
        if (lib.status === 'error' || !sessions.has(id)) {
          yield* updateLibrary(id, (latest) => ({ ...latest, status: 'connecting', error: null }))
          yield* FiberMap.run(connections, id, supervise(id))
          return
        }
        yield* setError(id, null)
        yield* refreshCatalog(id)
      })

    const login = (id: ProviderId) =>
      Effect.gen(function* () {
        const session = yield* ready(id)
        if (!session.login) return yield* rejected(signInElsewhere(id))
        const url = yield* session.login
        yield* updateLibrary(id, (lib) => ({ ...lib, loginUrl: url }))
        yield* options.openExternal(url)
      })

    const logout = (id: ProviderId) =>
      Effect.gen(function* () {
        const session = yield* ready(id)
        if (!session.logout) return yield* rejected(signInElsewhere(id))
        yield* session.logout
        yield* goHome(id)
        yield* refreshCatalog(id)
      })

    const connectTool = (id: ProviderId, name: string) =>
      Effect.gen(function* () {
        const session = yield* ready(id)
        if (!session.connectTool) return yield* rejected('Manage this library’s tools in a terminal.')
        const url = yield* session.connectTool(name)
        yield* updateLibrary(id, (lib) => ({ ...lib, loginUrl: url, error: null }))
        yield* options.openExternal(url)
      })

    const setProvider = (next: ProviderId, home = false) =>
      Effect.gen(function* () {
        // Switching is one state write, so a slow start can never overwrite a newer choice.
        if (home) {
          yield* FiberHandle.clear(navigation)
          yield* touchDisplayed(next)
        }
        yield* update((current) => {
          const switched = { ...current, active: next }
          return home ? S.updateLibrary(switched, next, (lib) => ({ ...lib, route: HOME, opening: null })) : switched
        })
        yield* ensureConnection(next)
      })

    const dispatch = (command: Exclude<Command, { op: 'openFolder' }>): Effect.Effect<void, ManagerError> =>
      Effect.gen(function* () {
        const id = yield* active
        switch (command.op) {
          case 'setProvider':
            return yield* setProvider(command.provider, command.home)
          case 'newDocument':
            return yield* newDocument(id, command)
          case 'createProject':
            return yield* createProject(id, command.name, command.cwd)
          case 'openThread':
            return yield* openThread(id, command.threadId)
          case 'goHome':
            return yield* goHome(id)
          case 'send':
            return yield* send(id, command)
          case 'interrupt':
            return yield* interrupt(id)
          case 'login':
            return yield* login(id)
          case 'logout':
            return yield* logout(id)
          case 'connectMcp':
            return yield* connectTool(id, command.name)
          case 'setSearch':
            return yield* updateLibrary(id, (lib) => ({ ...lib, search: command.value }))
          case 'applySearch':
            return yield* refreshing(id, 'docs', refreshDocs(id)).pipe(Effect.flatMap(joinSuperseded))
          case 'setModel':
            return yield* updateLibrary(id, (lib) => S.withModel(lib, command.model))
          case 'setEffort':
            return yield* updateLibrary(id, (lib) => ({ ...lib, settings: { ...lib.settings, effort: command.effort } }))
          case 'setServiceTier':
            return yield* updateLibrary(id, (lib) => ({ ...lib, settings: { ...lib.settings, serviceTier: command.serviceTier } }))
          case 'setCollaborationMode':
            return yield* updateLibrary(id, (lib) =>
              lib.catalog.modes.length && !lib.catalog.modes.some((mode) => mode.id === command.name)
                ? lib
                : { ...lib, settings: { ...lib.settings, mode: command.name } },
            )
          case 'loadOlderTurns':
            return yield* loadOlder(id)
          case 'resolveApproval':
            return yield* resolveApproval(id, command)
          case 'setDocumentName':
            return yield* rename(id, command.name)
          case 'refresh':
            return yield* refresh(id)
        }
      })

    return ProviderSessionManager.of({
      snapshot: Effect.map(read, S.toSnapshot),
      snapshots: SubscriptionRef.changes(state).pipe(Stream.map(S.toSnapshot)),
      start: (provider) =>
        Effect.gen(function* () {
          yield* update((current) => ({ ...current, active: provider }))
          yield* ensureConnection(provider)
        }),
      dispatch,
      setFolder: (cwd) =>
        Effect.gen(function* () {
          const id = yield* active
          yield* updateLibrary(id, (lib) => ({ ...lib, cwd }))
          if ((yield* read).libraries[id].route.kind === 'home') yield* refreshing(id, 'skills', refreshSkills(id, cwd))
        }),
      notify: (message) => Effect.flatMap(active, (id) => setError(id, message)),
      runtimeCount: Effect.map(read, (current) => current.runtimes.size),
    })
  })

export const layer = (options: ManagerOptions) => Layer.effect(ProviderSessionManager, make(options))
