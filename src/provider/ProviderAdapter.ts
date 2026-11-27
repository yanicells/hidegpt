import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import type * as Stream from 'effect/Stream'

import type {
  AccountSummary,
  ApprovalReply,
  Block,
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

/**
 * The one interface every provider implements (Codex app-server, OpenCode
 * serve, Claude Agent SDK), shaped like T3 Code's `ProviderAdapterV2`:
 * `openSession` starts the backend inside a `Scope`, and closing that scope
 * stops it (kills its process group). Adapters hold no UI state and never
 * filter by route: every thread event names its thread, and the session
 * manager decides what the window shows. See docs/architecture.md §2.
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
  /** Succeeds once the provider accepted the turn; progress arrives as events. */
  readonly send: (threadId: string, input: TurnInput, settings: TurnSettings) => Effect.Effect<void, ProviderError>
  readonly interrupt: (threadId: string) => Effect.Effect<void, ProviderError>
  /** Fails when the provider did not take the reply; the approval then stays open. */
  readonly respond: (threadId: string, approvalId: string, reply: ApprovalReply) => Effect.Effect<void, ProviderError>
  readonly rename: (threadId: string, name: string) => Effect.Effect<void, ProviderError>
  /** Drops server-side resources for an idle, off-screen thread. Never fails. */
  readonly releaseThread: (threadId: string) => Effect.Effect<void>

  // Optional: present exactly when the matching `Capabilities` flag is on (checked by `capabilities.test.ts`).
  readonly createProject?: (name: string, cwd: string) => Effect.Effect<void, ProviderError>
  /** Returns the URL to finish signing in. */
  readonly login?: Effect.Effect<string, ProviderError>
  readonly logout?: Effect.Effect<void, ProviderError>
  /** Returns the OAuth URL for an MCP server. */
  readonly connectTool?: (name: string) => Effect.Effect<string, ProviderError>
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
  readonly blocks: ReadonlyArray<Block>
  /** Cursor for the page before `blocks`, or null at the start. */
  readonly olderCursor: string | null
  readonly cwd: string
  /** What the thread last ran with; the toolbar adopts it. */
  readonly settings?: Partial<TurnSettings>
  /** A turn is already running (opened mid-answer). */
  readonly streaming?: boolean
}

export type OlderPage = { readonly blocks: ReadonlyArray<Block>; readonly cursor: string | null }

/** What can go stale on Home; the manager refetches (debounced). */
export type CatalogPart = 'docs' | 'account' | 'projects' | 'skills' | 'tools'

export type TextTarget = { readonly kind: 'agent' } | { readonly kind: 'callout'; readonly title: string }

export type ThreadEvent =
  | { readonly type: 'turnStarted'; readonly threadId: string }
  /** Terminal: always ends the "Working…" state. */
  | { readonly type: 'turnEnded'; readonly threadId: string; readonly error?: string }
  /** Insert or replace by id; `replaces` names the optimistic echo a server user message confirms. */
  | { readonly type: 'block'; readonly threadId: string; readonly block: Block; readonly replaces?: string | null }
  | {
      readonly type: 'text'
      readonly threadId: string
      readonly blockId: string
      readonly delta: string
      readonly create?: TextTarget
    }
  | { readonly type: 'resolved'; readonly threadId: string; readonly blockId: string; readonly resolved: 'accepted' | 'skipped' }
  /** Replace the thread's blocks (after a reconnect); open approvals are kept. */
  | { readonly type: 'reset'; readonly threadId: string; readonly blocks: ReadonlyArray<Block>; readonly streaming?: boolean }
  | { readonly type: 'title'; readonly threadId: string; readonly title: string }
  /** The thread is gone (deleted, archived) and cannot be used. */
  | { readonly type: 'closed'; readonly threadId: string }

export type AdapterEvent =
  | ThreadEvent
  | { readonly type: 'invalidate'; readonly part: CatalogPart }
  /** Non-blocking banner text (warnings, config problems). */
  | { readonly type: 'notice'; readonly message: string }
  /** Takes down a `notice` that no longer applies, if the banner still shows it. */
  | { readonly type: 'clearNotice'; readonly message: string }
  | { readonly type: 'loginUrl'; readonly url: string | null }

export const isThreadEvent = (event: AdapterEvent): event is ThreadEvent => 'threadId' in event
