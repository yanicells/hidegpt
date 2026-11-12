import { appendText, openApprovals, updateApproval, upsertBlock } from '../../shared/blocks'
import { CAPABILITIES, HOME, NO_BLOCKS } from '../../shared/model'
import type { Block, DocSummary, ProviderId, Route, Skill, Snapshot } from '../../shared/model'
import { EMPTY_CATALOG, type Catalog, type OpenedThread, type ThreadEvent, type TurnSettings } from '../../provider/ProviderAdapter'

/**
 * The session manager's state as plain immutable data, plus the pure
 * functions that change it. The Effect service in `ProviderSessionManager`
 * owns one `SubscriptionRef<State>` and only ever calls these, so every rule
 * about what the window shows is testable without a runtime.
 */

/** One document kept in memory: open, or recently open and still streaming or waiting. */
export type ThreadRuntime = {
  readonly provider: ProviderId
  readonly threadId: string
  readonly title: string
  readonly blocks: ReadonlyArray<Block>
  readonly streaming: boolean
  /** Stop was pressed; `streaming` stays on until the turn really ends. */
  readonly stopping: boolean
  readonly olderCursor: string | null
  readonly loadingOlder: boolean
  readonly cwd: string
  readonly touchedAt: number
  /** A background turn's failure, shown when the document is opened. */
  readonly error: string | null
  /** The provider lost this thread's server state (crash); reopening reloads it. */
  readonly stale: boolean
}

/** Everything Home and the toolbar show for one provider. */
export type Library = {
  readonly id: ProviderId
  readonly status: Snapshot['status']
  readonly error: string | null
  readonly loginUrl: string | null
  readonly catalog: Catalog
  readonly docs: ReadonlyArray<DocSummary>
  readonly skills: ReadonlyArray<Skill>
  readonly skillsCwd: string | null
  readonly settings: TurnSettings
  readonly search: string
  readonly cwd: string
  readonly route: Route
  readonly opening: string | null
}

export type State = {
  readonly active: ProviderId
  readonly libraries: Readonly<Record<ProviderId, Library>>
  readonly runtimes: ReadonlyMap<string, ThreadRuntime>
}

export const keyOf = (provider: ProviderId, threadId: string) => `${provider}:${threadId}`

const NO_SETTINGS: TurnSettings = { model: null, effort: null, serviceTier: null, mode: null }

const library = (id: ProviderId, cwd: string): Library => ({
  id,
  status: 'connecting',
  error: null,
  loginUrl: null,
  catalog: EMPTY_CATALOG,
  docs: [],
  skills: [],
  skillsCwd: null,
  settings: NO_SETTINGS,
  search: '',
  cwd,
  route: HOME,
  opening: null,
})

export const initialState = (active: ProviderId, defaultCwd: (id: ProviderId) => string): State => ({
  active,
  libraries: {
    codex: library('codex', defaultCwd('codex')),
    opencode: library('opencode', defaultCwd('opencode')),
    claude: library('claude', defaultCwd('claude')),
  },
  runtimes: new Map(),
})

export function displayedRuntime(state: State, provider: ProviderId = state.active): ThreadRuntime | undefined {
  const route = state.libraries[provider].route
  return route.kind === 'doc' ? state.runtimes.get(keyOf(provider, route.threadId)) : undefined
}

/**
 * The document its own library shows. Each library keeps its route while
 * another one is active, so a switch back lands on that document again: it
 * must not be released, and its errors belong on that library's banner.
 */
export function isDisplayed(state: State, runtime: ThreadRuntime): boolean {
  const route = state.libraries[runtime.provider].route
  return route.kind === 'doc' && route.threadId === runtime.threadId
}

/** What the window draws. Unchanged parts keep their references, so patches stay small. */
export function toSnapshot(state: State): Snapshot {
  const lib = state.libraries[state.active]
  const runtime = displayedRuntime(state)
  return {
    provider: lib.id,
    capabilities: CAPABILITIES[lib.id],
    status: lib.status,
    error: lib.error,
    account: lib.catalog.account,
    requiresAuth: lib.catalog.requiresAuth,
    loginUrl: lib.loginUrl,
    models: lib.catalog.models,
    model: lib.settings.model,
    effort: lib.settings.effort,
    serviceTier: lib.settings.serviceTier,
    collaborationModes: lib.catalog.modes,
    collaborationMode: lib.settings.mode,
    projects: lib.catalog.projects,
    threads: lib.docs,
    cwd: runtime?.cwd ?? lib.cwd,
    search: lib.search,
    mcpServers: lib.catalog.tools,
    skills: lib.skills,
    route: lib.route,
    title: runtime?.title ?? 'Docs',
    blocks: runtime?.blocks ?? NO_BLOCKS,
    streaming: runtime?.streaming ?? false,
    stopping: runtime?.stopping ?? false,
    hasOlder: Boolean(runtime?.olderCursor),
    loadingOlder: runtime?.loadingOlder ?? false,
    openingThreadId: lib.opening,
  }
}

export const updateLibrary = (state: State, id: ProviderId, update: (lib: Library) => Library): State => ({
  ...state,
  libraries: { ...state.libraries, [id]: update(state.libraries[id]) },
})

export function updateRuntime(state: State, key: string, update: (runtime: ThreadRuntime) => ThreadRuntime): State {
  const runtime = state.runtimes.get(key)
  if (!runtime) return state
  const runtimes = new Map(state.runtimes)
  runtimes.set(key, update(runtime))
  return { ...state, runtimes }
}

export function removeRuntime(state: State, key: string): State {
  if (!state.runtimes.has(key)) return state
  const runtimes = new Map(state.runtimes)
  runtimes.delete(key)
  return { ...state, runtimes }
}

/** The turn is over: no spinner, no pending stop. */
export const settle = (runtime: ThreadRuntime): ThreadRuntime =>
  runtime.streaming || runtime.stopping ? { ...runtime, streaming: false, stopping: false } : runtime

/** Folds one provider event into the thread it names. Threads with no runtime are ignored here. */
export function applyThreadEvent(state: State, provider: ProviderId, event: ThreadEvent, now: number): State {
  const key = keyOf(provider, event.threadId)
  const runtime = state.runtimes.get(key)
  if (!runtime) return state
  const touched = { ...runtime, touchedAt: now }
  switch (event.type) {
    case 'turnStarted':
      return updateRuntime(state, key, () => ({ ...touched, streaming: true, stopping: false }))
    case 'turnEnded': {
      const shown = isDisplayed(state, runtime)
      const next = updateRuntime(state, key, () => ({
        ...settle(touched),
        error: event.error && !shown ? event.error : touched.error,
      }))
      return event.error && shown ? updateLibrary(next, provider, (lib) => ({ ...lib, error: event.error ?? null })) : next
    }
    case 'block':
      return updateRuntime(state, key, () => ({ ...touched, blocks: upsertBlock(runtime.blocks, event.block, event.replaces) }))
    case 'text':
      return updateRuntime(state, key, () => ({
        ...touched,
        blocks: appendText(runtime.blocks, event.blockId, event.delta, event.create),
      }))
    case 'resolved':
      return updateRuntime(state, key, () => ({
        ...touched,
        blocks: updateApproval(runtime.blocks, event.blockId, { resolved: event.resolved, pending: false }),
      }))
    case 'reset': {
      const ids = new Set(event.blocks.map((block) => block.id))
      const blocks = [...event.blocks, ...openApprovals(runtime.blocks).filter((block) => !ids.has(block.id))]
      const streaming = event.streaming ?? runtime.streaming
      return updateRuntime(state, key, () => ({ ...touched, blocks, streaming, stopping: streaming && runtime.stopping }))
    }
    case 'title': {
      const next = updateRuntime(state, key, () => ({ ...touched, title: event.title }))
      return renameDoc(next, provider, event.threadId, event.title)
    }
    case 'closed': {
      const next = removeRuntime(state, key)
      const route = next.libraries[provider].route
      return route.kind === 'doc' && route.threadId === event.threadId
        ? updateLibrary(next, provider, (lib) => ({ ...lib, route: HOME, error: 'This document is no longer available.' }))
        : next
    }
  }
}

export const renameDoc = (state: State, provider: ProviderId, threadId: string, name: string): State =>
  updateLibrary(state, provider, (lib) => ({
    ...lib,
    docs: lib.docs.map((doc) => (doc.id === threadId ? { ...doc, name } : doc)),
  }))

/** Stores an opened (or reloaded) thread. Approvals still waiting survive a reload. */
export function adopt(state: State, provider: ProviderId, opened: OpenedThread, now: number): State {
  const key = keyOf(provider, opened.threadId)
  const previous = state.runtimes.get(key)
  const ids = new Set(opened.blocks.map((block) => block.id))
  const runtimes = new Map(state.runtimes)
  runtimes.set(key, {
    provider,
    threadId: opened.threadId,
    title: opened.title,
    blocks: previous ? [...opened.blocks, ...openApprovals(previous.blocks).filter((block) => !ids.has(block.id))] : opened.blocks,
    streaming: Boolean(opened.streaming),
    stopping: false,
    olderCursor: opened.olderCursor,
    loadingOlder: false,
    cwd: opened.cwd,
    touchedAt: now,
    error: null,
    stale: false,
  })
  return { ...state, runtimes }
}

/** Shows a stored thread: route, no spinner, its pending background error on the banner. */
export function showThread(state: State, provider: ProviderId, threadId: string): State {
  const key = keyOf(provider, threadId)
  const runtime = state.runtimes.get(key)
  const shown = updateLibrary(state, provider, (lib) => ({
    ...lib,
    route: { kind: 'doc', threadId },
    opening: null,
    error: runtime?.error ?? null,
  }))
  return runtime?.error ? updateRuntime(shown, key, (item) => ({ ...item, error: null })) : shown
}

/** The toolbar adopts what the thread last ran with. */
export function adoptSettings(settings: TurnSettings, from: OpenedThread['settings']): TurnSettings {
  if (!from) return settings
  return {
    model: from.model || settings.model,
    effort: from.effort ?? settings.effort,
    serviceTier: from.serviceTier !== undefined ? from.serviceTier : settings.serviceTier,
    mode: from.mode || settings.mode,
  }
}

/** Fills unset settings from the catalog's defaults and drops a mode the provider no longer offers. */
export function applyDefaults(lib: Library): Library {
  const { models, modes, defaultMode } = lib.catalog
  const model = lib.settings.model ?? (models.find((item) => item.isDefault) ?? models[0])?.id ?? null
  const effort = lib.settings.effort ?? models.find((item) => item.id === model)?.defaultEffort ?? null
  const keepMode = lib.settings.mode && (!modes.length || modes.some((mode) => mode.id === lib.settings.mode))
  const mode = keepMode ? lib.settings.mode : (defaultMode ?? modes[0]?.id ?? null)
  return { ...lib, settings: { ...lib.settings, model, effort, mode } }
}

/** A new model keeps the effort when it supports it, and starts on the thread's default speed. */
export function withModel(lib: Library, model: string): Library {
  const entry = lib.catalog.models.find((item) => item.id === model)
  if (lib.catalog.models.length && !entry) return lib
  const effort =
    entry && lib.settings.effort && entry.efforts.includes(lib.settings.effort)
      ? lib.settings.effort
      : (entry?.defaultEffort ?? lib.settings.effort)
  return { ...lib, settings: { ...lib.settings, model, effort, serviceTier: null } }
}

/**
 * The provider process died: every running turn on it ends, approvals can no
 * longer be answered, the shown document reloads on reconnect, and other
 * documents are dropped (they reopen from the provider).
 */
export function connectionLost(state: State, provider: ProviderId, message: string): State {
  const runtimes = new Map(state.runtimes)
  for (const [key, runtime] of state.runtimes) {
    if (runtime.provider !== provider) continue
    if (isDisplayed(state, runtime)) {
      runtimes.set(key, {
        ...runtime,
        streaming: false,
        stopping: false,
        stale: true,
        blocks: runtime.blocks.map((block) =>
          block.kind === 'approval' && block.resolved === null ? { ...block, resolved: 'skipped', pending: false } : block,
        ),
      })
    } else {
      runtimes.delete(key)
    }
  }
  return updateLibrary({ ...state, runtimes }, provider, (lib) => ({ ...lib, status: 'connecting', error: message, opening: null }))
}

const hasOpenApproval = (runtime: ThreadRuntime) =>
  runtime.blocks.some((block) => block.kind === 'approval' && block.resolved === null)

/** Off-screen, settled runtimes to release: idle past `idleMs`, or the oldest beyond `maxIdle`. */
export function idleRuntimes(state: State, now: number, idleMs: number, maxIdle: number): ReadonlyArray<ThreadRuntime> {
  const idle = [...state.runtimes.values()]
    .filter((runtime) => !isDisplayed(state, runtime) && !runtime.streaming && !hasOpenApproval(runtime))
    .sort((a, b) => a.touchedAt - b.touchedAt)
  const excess = Math.max(0, idle.length - maxIdle)
  return idle.filter((runtime, index) => index < excess || now - runtime.touchedAt >= idleMs)
}
