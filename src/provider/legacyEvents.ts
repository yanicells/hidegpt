import type * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Queue from 'effect/Queue'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import type { ApprovalBlock, Block, Capabilities, DocSummary, ProviderId, Skill } from '../shared/model'
import type { ProviderError } from './errors'
import type { AssistantItem, Item, RequestItem, RequestKind, ToolItem } from './events'
import { classify } from './failure'
import type {
  AdapterEvent,
  Catalog,
  CatalogPart,
  CreateThreadOptions,
  OpenedThread,
  ProviderAdapter,
  ProviderSession,
  TurnInput,
  TurnSettings,
} from './ProviderAdapter'
import { makeTurnTracker, type TurnTracker } from './turnTracker'

/**
 * The contract adapters spoke before `./events`, and the wrapper that turns
 * one of those sessions into a canonical one, so the canonical contract could
 * land without touching an adapter. Each adapter moves off it in ARCH-4; ARCH-7
 * deletes this file and the `legacy` field on items.
 *
 * What the wrapper adds over the old behaviour, for all three adapters at once:
 * - every turn has the app id the manager allocated, and one terminal (the
 *   tracker drops a provider's duplicate `turnEnded`);
 * - Stop pressed before the provider confirmed the turn waits for that
 *   confirmation instead of being lost;
 * - a failure is typed (`classify`) and its provider text stays in the log.
 */

export type TextTarget = { readonly kind: 'agent' } | { readonly kind: 'callout'; readonly title: string }

export type LegacyThreadEvent =
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
  | {
      readonly type: 'resolved'
      readonly threadId: string
      readonly blockId: string
      readonly resolved: 'accepted' | 'skipped'
    }
  /** Replace the thread's blocks (after a reconnect); open approvals are kept. */
  | {
      readonly type: 'reset'
      readonly threadId: string
      readonly blocks: ReadonlyArray<Block>
      readonly streaming?: boolean
    }
  | { readonly type: 'title'; readonly threadId: string; readonly title: string }
  /** The thread is gone (deleted, archived) and cannot be used. */
  | { readonly type: 'closed'; readonly threadId: string }

export type LegacyAdapterEvent =
  | LegacyThreadEvent
  | { readonly type: 'invalidate'; readonly part: CatalogPart }
  | { readonly type: 'notice'; readonly message: string }
  | { readonly type: 'loginUrl'; readonly url: string | null }

export type LegacyOpenedThread = {
  readonly threadId: string
  readonly title: string
  readonly blocks: ReadonlyArray<Block>
  readonly olderCursor: string | null
  readonly cwd: string
  readonly settings?: Partial<TurnSettings>
  /** A turn is already running (opened mid-answer). */
  readonly streaming?: boolean
}

export type LegacyOlderPage = { readonly blocks: ReadonlyArray<Block>; readonly cursor: string | null }

export interface LegacyProviderSession {
  readonly events: Stream.Stream<LegacyAdapterEvent>
  readonly awaitExit: Effect.Effect<never, ProviderError>
  readonly loadCatalog: Effect.Effect<Catalog, ProviderError>
  readonly listDocs: (search: string) => Stream.Stream<ReadonlyArray<DocSummary>, ProviderError>
  readonly listSkills: (cwd: string) => Effect.Effect<ReadonlyArray<Skill>, ProviderError>
  readonly openThread: (threadId: string, hint?: DocSummary) => Effect.Effect<LegacyOpenedThread, ProviderError>
  readonly createThread: (options: CreateThreadOptions) => Effect.Effect<LegacyOpenedThread, ProviderError>
  readonly loadOlder: (threadId: string, cursor: string) => Effect.Effect<LegacyOlderPage, ProviderError>
  readonly messageId: () => string
  readonly send: (threadId: string, input: TurnInput, settings: TurnSettings) => Effect.Effect<void, ProviderError>
  readonly interrupt: (threadId: string) => Effect.Effect<void, ProviderError>
  readonly respond: ProviderSession['respond']
  readonly rename: ProviderSession['rename']
  readonly releaseThread: ProviderSession['releaseThread']
  readonly createProject?: ProviderSession['createProject']
  readonly login?: ProviderSession['login']
  readonly logout?: ProviderSession['logout']
  readonly connectTool?: ProviderSession['connectTool']
}

export interface LegacyProviderAdapter {
  readonly id: ProviderId
  readonly capabilities: Capabilities
  readonly openSession: Effect.Effect<LegacyProviderSession, ProviderError, Scope.Scope>
}

/** How long Stop waits for the provider to confirm a turn it was just sent. */
const STOP_WAITS_FOR_START = '10 seconds'

/** A legacy approval's suggestion verb, as the request kind it stands for. */
const REQUEST_OF: Record<ApprovalBlock['suggestion'], RequestKind> = {
  add: 'tool_access',
  replace: 'file_change',
  format: 'permissions',
  question: 'user_input',
}

/** A legacy block as an item. Tool and request wording rides along in `legacy` until the adapter moves. */
export function blockToItem(block: Block): Item {
  switch (block.kind) {
    case 'user':
      return block
    case 'agent':
      return { kind: 'assistant', id: block.id, text: block.text, phase: block.commentary ? 'commentary' : 'final' }
    case 'callout':
      return {
        kind: 'tool',
        id: block.id,
        tool: 'other',
        status: 'completed',
        subject: null,
        output: block.body,
        legacy: { title: block.title },
      }
    case 'approval':
      return {
        kind: 'request',
        id: block.id,
        request: REQUEST_OF[block.suggestion],
        status:
          block.resolved === 'accepted'
            ? 'accepted'
            : block.resolved === 'skipped'
              ? 'declined'
              : block.pending
                ? 'sending'
                : 'pending',
        subject: null,
        detail: block.body,
        fields: block.fields,
        questions: block.questions,
        legacy: { title: block.title },
      }
  }
}

/** What a legacy delta creates when its block is not on the page yet. */
function deltaTarget(id: string, target: TextTarget | undefined): AssistantItem | ToolItem {
  return target?.kind === 'callout'
    ? { kind: 'tool', id, tool: 'other', status: 'running', subject: null, output: '', legacy: { title: target.title } }
    : { kind: 'assistant', id, text: '', phase: 'final' }
}

/** A legacy adapter as a canonical one. Each session gets its own turn tracker. */
export const fromLegacy = (adapter: LegacyProviderAdapter): ProviderAdapter => ({
  id: adapter.id,
  capabilities: adapter.capabilities,
  openSession: Effect.flatMap(adapter.openSession, (legacy) => wrapSession(adapter.id, legacy)),
})

const wrapSession = (provider: ProviderId, legacy: LegacyProviderSession) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<AdapterEvent, Cause.Done>()
    const emit = (event: AdapterEvent) => Effect.asVoid(Queue.offer(queue, event))
    const tracker = yield* makeTurnTracker({ provider, emit })
    /** Approvals still open, so a legacy `resolved` (which names only the id) can re-send the whole item. */
    const openRequests = new Map<string, RequestItem>()

    const toItems = (blocks: ReadonlyArray<Block>): Item[] =>
      blocks.map((block) => {
        const item = blockToItem(block)
        if (item.kind === 'request' && item.status === 'pending') openRequests.set(item.id, item)
        return item
      })

    const toOpened = (opened: LegacyOpenedThread) =>
      Effect.gen(function* () {
        const { blocks, streaming, ...rest } = opened
        const activeTurnId = streaming ? yield* tracker.adopt(opened.threadId, null) : null
        return { ...rest, items: toItems(blocks), activeTurnId } satisfies OpenedThread
      })

    yield* legacy.events.pipe(
      Stream.runForEach((event) => translate(event, { tracker, emit, toItems, openRequests })),
      Effect.exit,
      // The consumer sees the end of the legacy stream, or its failure (a defect included), as its own.
      Effect.flatMap((exit) => (Exit.isSuccess(exit) ? Queue.end(queue) : Queue.failCause(queue, exit.cause))),
      Effect.forkScoped,
    )

    return {
      events: Stream.fromQueue(queue),
      // Turns still open when the backend dies end as failed, so nothing waits on them.
      awaitExit: legacy.awaitExit.pipe(Effect.tapError((error) => tracker.failAll(error.message))),
      loadCatalog: legacy.loadCatalog,
      listDocs: legacy.listDocs,
      listSkills: legacy.listSkills,
      openThread: (threadId, hint) => Effect.flatMap(legacy.openThread(threadId, hint), toOpened),
      createThread: (options) => Effect.flatMap(legacy.createThread(options), toOpened),
      loadOlder: (threadId, cursor) =>
        Effect.map(legacy.loadOlder(threadId, cursor), (page) => ({
          items: toItems(page.blocks),
          cursor: page.cursor,
        })),
      messageId: legacy.messageId,
      send: (threadId, turnId, input, settings) =>
        Effect.gen(function* () {
          yield* tracker.begin(threadId, turnId)
          yield* legacy.send(threadId, input, settings).pipe(Effect.onError(() => tracker.abandon(threadId, turnId)))
          // The provider accepted it, so it knows the turn. Only this turn: it may already have ended.
          yield* tracker.started(threadId, null, turnId)
        }),
      interrupt: (threadId, turnId) =>
        Effect.gen(function* () {
          yield* tracker.requestStop(threadId, turnId)
          yield* tracker.awaitStarted(threadId, turnId, STOP_WAITS_FOR_START)
          yield* legacy.interrupt(threadId)
        }),
      respond: legacy.respond,
      rename: legacy.rename,
      releaseThread: legacy.releaseThread,
      ...(legacy.createProject ? { createProject: legacy.createProject } : {}),
      ...(legacy.login ? { login: legacy.login } : {}),
      ...(legacy.logout ? { logout: legacy.logout } : {}),
      ...(legacy.connectTool ? { connectTool: legacy.connectTool } : {}),
    } satisfies ProviderSession
  })

type Translation = {
  readonly tracker: TurnTracker
  readonly emit: (event: AdapterEvent) => Effect.Effect<void>
  readonly toItems: (blocks: ReadonlyArray<Block>) => Item[]
  readonly openRequests: Map<string, RequestItem>
}

/** One legacy event as canonical ones. The tracker emits the turn events itself. */
function translate(event: LegacyAdapterEvent, { tracker, emit, toItems, openRequests }: Translation) {
  switch (event.type) {
    case 'turnStarted':
      return tracker.started(event.threadId, null)
    case 'turnEnded':
      return tracker.end(
        event.threadId,
        event.error === undefined
          ? { status: 'completed', failure: null }
          : { status: 'failed', failure: classify({ message: event.error }) },
      )
    case 'block': {
      const [item] = toItems([event.block])
      return emit({
        type: 'item.upserted',
        threadId: event.threadId,
        turnId: tracker.current(event.threadId),
        item: item!,
        ...(event.replaces !== undefined ? { replaces: event.replaces } : {}),
      })
    }
    case 'text':
      return emit({
        type: 'item.delta',
        threadId: event.threadId,
        itemId: event.blockId,
        delta: event.delta,
        create: deltaTarget(event.blockId, event.create),
      })
    case 'resolved': {
      const request = openRequests.get(event.blockId)
      openRequests.delete(event.blockId)
      if (!request) return Effect.logDebug('Resolved an approval this session never saw')
      // `skipped` from the provider means it settled the request itself (the turn ended, or it was stopped).
      const status = event.resolved === 'accepted' ? 'accepted' : 'expired'
      return emit({
        type: 'item.upserted',
        threadId: event.threadId,
        turnId: tracker.current(event.threadId),
        item: { ...request, status },
      })
    }
    case 'reset':
      return Effect.gen(function* () {
        const activeTurnId =
          event.streaming === undefined
            ? tracker.current(event.threadId)
            : event.streaming
              ? yield* tracker.adopt(event.threadId, null)
              : null
        yield* emit({ type: 'thread.reset', threadId: event.threadId, items: toItems(event.blocks), activeTurnId })
      })
    case 'title':
      return emit({ type: 'thread.renamed', threadId: event.threadId, title: event.title })
    case 'closed':
      return Effect.gen(function* () {
        if (tracker.current(event.threadId) !== null)
          yield* tracker.end(event.threadId, { status: 'interrupted', failure: null })
        yield* emit({ type: 'thread.closed', threadId: event.threadId })
      })
    case 'invalidate':
    case 'notice':
    case 'loginUrl':
      return emit(event)
  }
}
