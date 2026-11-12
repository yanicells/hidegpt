import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import type * as Stream from 'effect/Stream'

import type {
  AccountSummary,
  ApprovalReply,
  Capabilities,
  DocSummary,
  ModelOption,
  ModeOption,
  ProjectSummary,
  ProviderId,
  Skill,
  ToolServer,
} from '../shared/model'
import type { ProviderError } from './errors'
import type { Item, ThreadEvent, TurnId } from './events'

export type { ThreadEvent } from './events'

/**
 * The one interface every provider implements (Codex app-server, OpenCode
 * serve, Claude Agent SDK), shaped like T3 Code's `ProviderAdapterV2`:
 * `openSession` starts the backend inside a `Scope`, and closing that scope
 * stops it (kills its process group). Adapters hold no UI state and never
 * filter by route: every thread event names its thread, and the session
 * manager decides what the window shows. See docs/architecture.md §2.
 *
 * Sessions speak the canonical contract in `./events`: typed items, and turns
 * with app-owned ids. Adapters not yet moved onto it are wrapped by
 * `fromLegacy` (`./legacyEvents`).
 */
export interface ProviderAdapter {
  readonly id: ProviderId
  readonly capabilities: Capabilities
  /** Spawns/connects and finishes the handshake (with a deadline). Fails with a tagged error. */
  readonly openSession: Effect.Effect<ProviderSession, ProviderError, Scope.Scope>
}

/** One live connection. Every operation carries its own timeout. */
export interface ProviderSession {
  /** Everything the backend reports. Ends when the session's scope closes. */
  readonly events: Stream.Stream<AdapterEvent>
  /** Fails once the backend is gone (crash, closed stream); never succeeds. */
  readonly awaitExit: Effect.Effect<never, ProviderError>

  readonly loadCatalog: Effect.Effect<Catalog, ProviderError>
  /** Emits the documents listed so far after each page, so Home can paint the first page early. */
  readonly listDocs: (search: string) => Stream.Stream<ReadonlyArray<DocSummary>, ProviderError>
  readonly listSkills: (cwd: string) => Effect.Effect<ReadonlyArray<Skill>, ProviderError>

  readonly openThread: (threadId: string, hint?: DocSummary) => Effect.Effect<OpenedThread, ProviderError>
  readonly createThread: (options: CreateThreadOptions) => Effect.Effect<OpenedThread, ProviderError>
  readonly loadOlder: (threadId: string, cursor: string) => Effect.Effect<OlderPage, ProviderError>
  /** Id for the optimistic user echo; providers that accept client ids send it with the turn. */
  readonly messageId: () => string
  /**
   * Starts turn `turnId` (allocated by the manager). Succeeds once the provider accepted it;
   * progress arrives as events stamped with that id.
   */
  readonly send: (
    threadId: string,
    turnId: TurnId,
    input: TurnInput,
    settings: TurnSettings,
  ) => Effect.Effect<void, ProviderError>
  /** Asks the provider to stop turn `turnId`, waiting briefly if it has not started yet. Its terminal comes as an event. */
  readonly interrupt: (threadId: string, turnId: TurnId) => Effect.Effect<void, ProviderError>
  /** Fails when the provider did not take the reply; the approval then stays open. */
  readonly respond: (threadId: string, approvalId: string, reply: ApprovalReply) => Effect.Effect<void, ProviderError>
  readonly rename: (threadId: string, name: string) => Effect.Effect<void, ProviderError>
  /** Drops server-side resources for an idle, off-screen thread. Never fails. */
  readonly releaseThread: (threadId: string) => Effect.Effect<void>

  // Optional: present exactly when the matching `Capabilities` flag is on (see `CAPABILITY_METHODS`).
  readonly createProject?: (name: string, cwd: string) => Effect.Effect<void, ProviderError>
  /** Returns the URL to finish signing in. */
  readonly login?: Effect.Effect<string, ProviderError>
  readonly logout?: Effect.Effect<void, ProviderError>
  /** Returns the OAuth URL for an MCP server. */
  readonly connectTool?: (name: string) => Effect.Effect<string, ProviderError>
}

/**
 * The optional session methods each capability flag promises. The renderer reads the
 * flag (from `CAPABILITIES`) and the manager calls the method, so the two must agree;
 * a test checks every adapter with `capabilityMismatches`. `gitProjects` names no method.
 */
export const CAPABILITY_METHODS: ReadonlyArray<readonly [keyof Capabilities, keyof OptionalMethods]> = [
  ['login', 'login'],
  ['login', 'logout'],
  ['connectTools', 'connectTool'],
  ['createProjects', 'createProject'],
]

type OptionalMethods = Pick<ProviderSession, 'login' | 'logout' | 'connectTool' | 'createProject'>

/** Each flag/method pair that disagrees, e.g. `login: true but logout is missing`; empty when they agree. */
export function capabilityMismatches(capabilities: Capabilities, session: OptionalMethods): string[] {
  return CAPABILITY_METHODS.flatMap(([flag, method]) => {
    const present = session[method] !== undefined
    return present === capabilities[flag]
      ? []
      : [`${flag}: ${capabilities[flag]} but ${method} is ${present ? 'present' : 'missing'}`]
  })
}

export type Catalog = {
  readonly account: AccountSummary | null
  readonly requiresAuth: boolean
  readonly models: ReadonlyArray<ModelOption>
  readonly modes: ReadonlyArray<ModeOption>
  readonly defaultMode: string | null
  readonly projects: ReadonlyArray<ProjectSummary>
  readonly tools: ReadonlyArray<ToolServer>
}

export const EMPTY_CATALOG: Catalog = {
  account: null,
  requiresAuth: false,
  models: [],
  modes: [],
  defaultMode: null,
  projects: [],
  tools: [],
}

export type TurnSettings = {
  readonly model: string | null
  readonly effort: string | null
  readonly serviceTier: string | null
  readonly mode: string | null
}

export type TurnInput = {
  readonly text: string
  readonly images: ReadonlyArray<string>
  readonly skill: Skill | null
  readonly clientId: string
}

export type CreateThreadOptions = {
  readonly cwd: string
  readonly projectId: string | null
  readonly title: string | null
  readonly settings: TurnSettings
}

export type OpenedThread = {
  readonly threadId: string
  readonly title: string
  readonly items: ReadonlyArray<Item>
  /** Cursor for the page before `items`, or null at the start. */
  readonly olderCursor: string | null
  readonly cwd: string
  /** What the thread last ran with; the toolbar adopts it. */
  readonly settings?: Partial<TurnSettings>
  /** The turn already running (opened mid-answer), adopted under an app id. */
  readonly activeTurnId: TurnId | null
}

export type OlderPage = { readonly items: ReadonlyArray<Item>; readonly cursor: string | null }

/** What can go stale on Home; the manager refetches (debounced). */
export type CatalogPart = 'docs' | 'account' | 'projects' | 'skills' | 'tools'

/** Events not about one thread. */
export type LibraryEvent =
  | { readonly type: 'invalidate'; readonly part: CatalogPart }
  /** Non-blocking banner text (warnings, config problems). */
  | { readonly type: 'notice'; readonly message: string }
  | { readonly type: 'loginUrl'; readonly url: string | null }

export type AdapterEvent = ThreadEvent | LibraryEvent

export const isThreadEvent = (event: AdapterEvent): event is ThreadEvent => 'threadId' in event
