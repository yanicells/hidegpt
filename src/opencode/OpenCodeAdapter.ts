import { randomBytes, randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { createOpencodeClient, type GlobalEvent, type OpencodeClient, type Part } from '@opencode-ai/sdk/v2/client'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import { CAPABILITIES } from '../shared/model'
import type { ApprovalBlock, DocSummary, Skill } from '../shared/model'
import {
  NotLoggedInError,
  ProcessExitedError,
  ProviderDefectError,
  ProviderRequestError,
  type ProviderError,
  ProviderTimeoutError,
} from '../provider/errors'
import { logDefects, reportDefect } from '../provider/DefectReport'
import type { ProcessSupervisor } from '../provider/ProcessSupervisor'
import type {
  AdapterEvent,
  Catalog,
  OpenedThread,
  ProviderAdapter,
  ProviderSession,
  ThreadEvent,
} from '../provider/ProviderAdapter'
import {
  blocksFromMessages,
  defaultMode,
  imagePart,
  joinAgentText,
  type MessageWithParts,
  modelKey,
  permissionBlock,
  permissionBlockId,
  questionBlock,
  questionId,
  readableProviderError,
  sessionTitle,
  skillPart,
  splitModelKey,
  toDoc,
  toModels,
  toModes,
  toolCallout,
  toProjects,
  userBlock,
} from './mapping'

/**
 * OpenCode (`opencode serve`, REST + SSE) as a `ProviderAdapter`, over the
 * official SDK the way T3 Code's OpenCode adapter uses it: every call is an
 * `Effect.tryPromise` with an abort signal and a deadline, the global event
 * stream is one scoped subscription, and its end (or the process exiting)
 * ends the session so the manager reconnects. See docs/architecture.md §3.
 */

/** A running server: its URL, auth headers, and how to notice it died. Tests pass an in-process `fetch`. */
export type Server = {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof fetch
  readonly awaitExit: Effect.Effect<never, ProviderError>
}

export type Connect = Effect.Effect<Server, ProviderError, Scope.Scope>

const provider = 'opencode' as const
const DEFAULT_DEADLINE = 30
/** Messages per page when opening a document or loading earlier text. */
const PAGE = 60
const DOC_PAGE = 100
const MAX_DOC_PAGES = 10
/** The server heartbeats every 10 s; three missed beats mean the stream stalled. */
export const WATCHDOG = Duration.seconds(30)
/** Quick re-subscribes before giving up and restarting the server. Resets once events flow again. */
const RESUBSCRIBE = Schedule.exponential('250 millis').pipe(Schedule.upTo({ times: 5 }))
const SERVER_READY = 20
/** How far up a subagent's parents `resolveRoot` asks the server. */
const ROUTE_HOPS = 5
/**
 * Each parent lookup's deadline. Lookups run inside the event loop so a request stays in order
 * with the events around it; a stuck one therefore stalls every document's events, by design,
 * for up to 5 s per level. T3 Code sets no deadline at all.
 */
const LOOKUP_SECONDS = 5
/** Retries for a request whose document is still unknown: 200 ms doubling to 2 s, about 5 s in all. */
const ROUTE_RETRIES = 5
/** Stop's walk over subagent sessions: its deadline and how many requests run at once. */
const ABORT_DESCENDANTS_SECONDS = 15
const ABORT_CONCURRENCY = 8
const NO_MODELS =
  'OpenCode has no model providers set up. Run `opencode auth login` in a terminal, then use Tools → Refresh.'

type Client = OpencodeClient
/** `throwOnError` makes every SDK result `{ data, response }` and every failure a rejection. */
const opts = (signal: AbortSignal) => ({ signal, throwOnError: true as const })

/** The `cause` the SDK's `throwOnError` attaches to an error response; `status` is absent on other errors. */
const ResponseFailure = Schema.Struct({
  status: Schema.UndefinedOr(Schema.Number),
  body: Schema.optionalKey(Schema.Unknown),
})
/** OpenCode's error body: a named error with `data.message`, or a plain `message`. */
const ErrorBody = Schema.Union([
  Schema.Struct({ data: Schema.Struct({ message: Schema.String }) }),
  Schema.Struct({ message: Schema.String }),
])
/** A Node network error, as the `cause` of fetch's own `TypeError`. */
const NetworkFailure = Schema.Struct({ code: Schema.String })
const decodeResponseFailure = Schema.decodeUnknownOption(ResponseFailure)
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody)
const decodeNetworkFailure = Schema.decodeUnknownOption(NetworkFailure)

/**
 * A readable sentence for an SDK rejection. With `throwOnError` the SDK wraps
 * an error response in an `Error` whose `cause` holds `{ body, status }`; a
 * network failure is fetch's own `TypeError`.
 */
export function errorDetail(cause: unknown): string {
  if (!(cause instanceof Error)) return 'OpenCode did not accept that request.'
  const response = Option.getOrUndefined(decodeResponseFailure(cause.cause))
  if (response) {
    // A 404 names an internal id ("Session not found: ses_…"); say it plainly instead.
    if (response.status === 404) return 'OpenCode could not find that document.'
    const body = Option.getOrUndefined(decodeErrorBody(response.body))
    const text = body ? ('data' in body ? body.data.message : body.message).trim() : ''
    return text || 'OpenCode did not accept that request.'
  }
  const network = Option.getOrUndefined(decodeNetworkFailure(cause.cause))
  if (cause.message === 'fetch failed' || network?.code === 'ECONNREFUSED') return 'OpenCode is not responding.'
  return cause.message || 'OpenCode could not do that.'
}

/** Whether an SDK rejection is the server's 404 (the session is gone). */
const isNotFound = (cause: unknown) =>
  cause instanceof Error && Option.getOrUndefined(decodeResponseFailure(cause.cause))?.status === 404

/** One SDK request with its deadline; failures become HideGPT's tagged errors. */
const request = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>, seconds = DEFAULT_DEADLINE) =>
  Effect.tryPromise({
    try: run,
    catch: (cause): ProviderError => new ProviderRequestError({ provider, operation, detail: errorDetail(cause) }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(seconds),
      orElse: () => Effect.fail(new ProviderTimeoutError({ provider, operation, seconds })),
    }),
  )

const rejected = (operation: string, detail: string) => new ProviderRequestError({ provider, operation, detail })
const streamLost = (detail: string) => new ProcessExitedError({ provider, code: null, signal: null, stderr: detail })

/**
 * Ascending `msg_` ids in OpenCode's own format, so a message Docs sends sorts
 * after everything already in the session and its echo keeps its id.
 * Adapted from T3 Code (packages/provider-opencode/src/server/adapter.ts, makeOpenCodeMessageId) at commit 8a14762c.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
export function makeMessageIds(now: () => number = Date.now): () => string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let clock = { at: 0, counter: 0 }
  return () => {
    const at = now()
    clock = at === clock.at ? { at, counter: clock.counter + 1 } : { at, counter: 1 }
    const time = BigInt.asUintN(48, BigInt(at) * 0x1000n + BigInt(clock.counter))
      .toString(16)
      .padStart(12, '0')
    const random = Array.from({ length: 28 }, () => alphabet[randomInt(alphabet.length)]).join('')
    return `msg_${time}${random}`
  }
}

/** What streams in for one session while it is open. Cleared when its turn ends. */
type Live = {
  readonly roles: Map<string, 'user' | 'assistant'>
  /** Assistant message id → its visible text parts, in order. Reasoning parts are never added. */
  readonly texts: Map<string, Map<string, string>>
  /** User messages from another client (the TUI), built from their parts. */
  readonly foreign: Map<string, Map<string, Part>>
  /** User messages Docs sent; their echo is already on the page. */
  readonly own: Set<string>
  pendingEcho: string | null
}

type PendingApproval = {
  readonly kind: 'permission' | 'question'
  readonly requestId: string
  readonly sessionId: string
  readonly questions: number
}

export function make(connect: Connect): ProviderAdapter {
  return {
    id: provider,
    capabilities: CAPABILITIES.opencode,
    openSession: Effect.gen(function* () {
      const server = yield* connect
      const client: Client = createOpencodeClient({
        baseUrl: server.url,
        ...(server.headers ? { headers: { ...server.headers } } : {}),
        ...(server.fetch ? { fetch: server.fetch } : {}),
      })
      yield* request('global.health', (signal) => client.global.health(opts(signal)), 10)

      const events = yield* Queue.unbounded<AdapterEvent>()
      yield* Effect.addFinalizer(() => Queue.shutdown(events))
      const emit = (event: AdapterEvent) => Queue.offer(events, event).pipe(Effect.asVoid)
      const emitAll = (list: ReadonlyArray<AdapterEvent>) => Effect.forEach(list, emit, { discard: true })
      const scope = yield* Scope.Scope

      /** Session directory: OpenCode routes every request to the instance for that folder. */
      const directories = new Map<string, string>()
      const titles = new Map<string, string>()
      /** Subagent session → the session that started it, so its questions reach the open document. */
      const parents = new Map<string, string>()
      /** Sessions the server says have no parent: documents, open or not. */
      const roots = new Set<string>()
      /** Documents this connection opened (resynced after a re-subscribe). */
      const opened = new Set<string>()
      const live = new Map<string, Live>()
      // Sessions mid-turn: a busy set like T3 Code's busySessionIds (packages/provider-opencode/src/server/adapter.ts),
      // used here to start each turn once. OpenCode repeats busy and retry during a turn.
      const busy = new Set<string>()
      const approvals = new Map<string, PendingApproval>()
      /** Requests whose document is still being looked up in the background; none is on screen yet. */
      const routing = new Set<string>()
      /** Requests Docs answered itself; their `replied` event is not news. */
      const answered = new Set<string>()
      const skillBodies = new Map<string, { location: string; content: string }>()
      const messageId = makeMessageIds()

      const dir = (sessionId: string) => directories.get(sessionId)
      /** Follows the parents already known, stopping at an open document. */
      const climb = (sessionId: string) => {
        let id = sessionId
        for (let depth = 0; depth < 8 && !opened.has(id) && parents.has(id); depth += 1) id = parents.get(id) ?? id
        return id
      }

      /**
       * The document a session belongs to: itself, or the document whose subagent started it.
       * Answers from memory when it can; otherwise asks the server for each parent, up to
       * five hops, and remembers every hop. `undefined` when a lookup fails or the chain runs out.
       * `directory` is where the event came from, for a session Docs has not seen yet.
       * Adapted from T3 Code (packages/provider-opencode/src/server/adapter.ts, resolveSessionOwner) at commit 5c6f2f12.
       * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
       */
      const resolveRoot = (sessionId: string, directory?: string): Effect.Effect<string | undefined> =>
        Effect.gen(function* () {
          const known = (id: string) => opened.has(id) || roots.has(id)
          let cursor = climb(sessionId)
          for (let hop = 0; hop < ROUTE_HOPS && !known(cursor); hop += 1) {
            const id = cursor
            const found = yield* request(
              'session.get',
              (signal) => client.session.get({ sessionID: id, directory: dir(id) ?? directory }, opts(signal)),
              LOOKUP_SECONDS,
            ).pipe(Effect.option)
            if (Option.isNone(found)) return undefined
            const info = found.value.data
            directories.set(id, info.directory)
            if (!info.parentID) roots.add(id)
            else {
              parents.set(id, info.parentID)
              cursor = climb(info.parentID)
            }
          }
          return known(cursor) ? cursor : undefined
        })

      /**
       * Shows a permission or question on its document. The lookup runs before the block is
       * emitted, so it stays in order with the events around it. A subagent's session can be
       * unknown for a moment after its first request: retry with backoff in the background, and in
       * the end give up, as T3 does (the document still shows it when it next opens, from
       * `pendingFor`). A request settled meanwhile is not shown.
       * Adapted from T3 Code (packages/provider-opencode/src/server/adapter.ts, routeRuntimeRequest) at commit 5c6f2f12.
       * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
       */
      const routeRequest = (sessionId: string, directory: string, block: ApprovalBlock): Effect.Effect<void> => {
        const show = (threadId: string) =>
          approvals.has(block.id) ? emit({ type: 'block', threadId, block }) : Effect.void
        const retry = Effect.gen(function* () {
          for (let attempt = 0; attempt < ROUTE_RETRIES; attempt += 1) {
            yield* Effect.sleep(Duration.millis(Math.min(200 * 2 ** attempt, 2_000)))
            if (!approvals.has(block.id)) return
            const root = yield* resolveRoot(sessionId, directory)
            if (root) {
              // Shown from here on, so a later answer resolves it.
              routing.delete(block.id)
              return yield* show(root)
            }
          }
        }).pipe(Effect.ensuring(Effect.sync(() => routing.delete(block.id))))
        return resolveRoot(sessionId, directory).pipe(
          Effect.flatMap((root) => {
            if (root) return show(root)
            routing.add(block.id)
            return retry.pipe(logDefects, Effect.forkIn(scope), Effect.asVoid)
          }),
        )
      }

      /**
       * Stops every subagent session under `rootId`, breadth first. A session already gone (404)
       * is skipped; the first other failure is returned after the walk, within 15 s.
       * Adapted from T3 Code (packages/provider-opencode/src/server/adapter.ts, abortDescendants) at commit 5c6f2f12.
       * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
       */
      const abortDescendants = (rootId: string): Effect.Effect<void, ProviderError> =>
        Effect.gen(function* () {
          const visited = new Set([rootId])
          let failure: ProviderError | undefined
          /** Runs a request; a 404 answers `null` and any other failure is kept, so the walk goes on. */
          const attempt = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
            request(operation, (signal) =>
              run(signal).catch((cause: unknown) => {
                if (isNotFound(cause)) return null
                throw cause
              }),
            ).pipe(
              Effect.catch((error) => {
                failure ??= error
                return Effect.succeed(null)
              }),
            )
          const childrenOf = (sessionId: string) =>
            attempt('session.children', (signal) =>
              client.session.children({ sessionID: sessionId, directory: dir(sessionId) }, opts(signal)),
            ).pipe(
              Effect.map((result) =>
                (result?.data ?? []).filter((child) => {
                  if (visited.has(child.id)) return false
                  visited.add(child.id)
                  directories.set(child.id, child.directory)
                  parents.set(child.id, sessionId)
                  return true
                }),
              ),
            )
          let frontier = yield* childrenOf(rootId)
          while (frontier.length > 0) {
            const next = yield* Effect.forEach(
              frontier,
              (child) =>
                attempt('session.abort', (signal) =>
                  client.session.abort({ sessionID: child.id, directory: dir(child.id) }, opts(signal)),
                ).pipe(Effect.andThen(childrenOf(child.id))),
              { concurrency: ABORT_CONCURRENCY },
            )
            frontier = next.flat()
          }
          if (failure) return yield* Effect.fail(failure)
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(ABORT_DESCENDANTS_SECONDS),
            orElse: () =>
              Effect.fail(
                new ProviderTimeoutError({
                  provider,
                  operation: 'session.abort',
                  seconds: ABORT_DESCENDANTS_SECONDS,
                }),
              ),
          }),
        )

      const liveOf = (sessionId: string): Live => {
        let state = live.get(sessionId)
        if (!state) {
          state = { roles: new Map(), texts: new Map(), foreign: new Map(), own: new Set(), pendingEcho: null }
          live.set(sessionId, state)
        }
        return state
      }
      /** Seeds streaming state from fetched messages, so deltas for a part already running keep landing. */
      const seed = (sessionId: string, messages: ReadonlyArray<MessageWithParts>) => {
        const state = liveOf(sessionId)
        for (const message of messages) {
          state.roles.set(message.info.id, message.info.role)
          if (message.info.role !== 'assistant') continue
          const texts = new Map<string, string>()
          for (const part of message.parts) {
            if (part.type === 'text' && !part.synthetic && !part.ignored) texts.set(part.id, part.text)
          }
          state.texts.set(message.info.id, texts)
        }
      }

      const messagesPage = (sessionId: string, before?: string) =>
        request(
          'session.messages',
          (signal) =>
            client.session.messages(
              { sessionID: sessionId, directory: dir(sessionId), limit: PAGE, ...(before ? { before } : {}) },
              opts(signal),
            ),
          60,
        ).pipe(
          Effect.map((result) => ({
            messages: result.data,
            cursor: result.response.headers.get('x-next-cursor') || null,
          })),
        )

      const isBusy = (sessionId: string) =>
        request('session.status', (signal) => client.session.status({ directory: dir(sessionId) }, opts(signal))).pipe(
          Effect.map((result) => {
            const status = result.data[sessionId]?.type
            return status === 'busy' || status === 'retry'
          }),
        )

      const register = (kind: PendingApproval['kind'], requestId: string, sessionId: string, questions = 0) => {
        approvals.set(permissionBlockId(requestId), { kind, requestId, sessionId, questions })
      }

      /** Questions already waiting when a document opens (asked while Docs was closed or on Home). */
      const pendingFor = (sessionId: string): Effect.Effect<ReadonlyArray<ApprovalBlock>> =>
        Effect.all(
          [
            request('permission.list', (signal) => client.permission.list({ directory: dir(sessionId) }, opts(signal))),
            request('question.list', (signal) => client.question.list({ directory: dir(sessionId) }, opts(signal))),
          ],
          { concurrency: 'unbounded' },
        ).pipe(
          Effect.flatMap(([permissions, questions]) => {
            // A subagent's request names the subagent's session: find the document it belongs to.
            const mine = (id: string) =>
              id === sessionId
                ? Effect.succeed(true)
                : resolveRoot(id, dir(sessionId)).pipe(Effect.map((root) => root === sessionId))
            const take = <T extends { readonly sessionID: string }>(items: ReadonlyArray<T>) =>
              Effect.filter(items, (item) => mine(item.sessionID), { concurrency: 4 })
            return Effect.all([take(permissions.data), take(questions.data)]).pipe(
              Effect.map(([ownPermissions, ownQuestions]) => {
                const blocks: ApprovalBlock[] = []
                for (const item of ownPermissions) {
                  register('permission', item.id, item.sessionID)
                  blocks.push(permissionBlock(item))
                }
                for (const item of ownQuestions) {
                  register('question', item.id, item.sessionID, item.questions.length)
                  blocks.push(questionBlock(item))
                }
                return blocks
              }),
            )
          }),
          // A document still opens when the pending lists are unavailable.
          Effect.orElseSucceed((): ReadonlyArray<ApprovalBlock> => []),
        )

      /** After a re-subscribe, events may have been missed: reload every open document from the server. */
      const resync = Effect.suspend(() =>
        Effect.forEach(
          [...opened],
          (threadId) =>
            Effect.all([messagesPage(threadId), isBusy(threadId), pendingFor(threadId)], {
              concurrency: 'unbounded',
            }).pipe(
              Effect.flatMap(([page, streaming, pending]) => {
                live.delete(threadId)
                seed(threadId, page.messages)
                if (streaming) busy.add(threadId)
                else busy.delete(threadId)
                const reset: ThreadEvent = {
                  type: 'reset',
                  threadId,
                  blocks: [...blocksFromMessages(page.messages), ...pending],
                  streaming,
                }
                return emitAll(streaming ? [reset] : [reset, { type: 'turnEnded', threadId }])
              }),
              Effect.ignore,
            ),
          { concurrency: 4, discard: true },
        ),
      )

      const endTurn = (sessionId: string, error?: string): ReadonlyArray<AdapterEvent> => {
        live.delete(sessionId)
        busy.delete(sessionId)
        return [{ type: 'turnEnded', threadId: sessionId, ...(error ? { error } : {}) }]
      }

      const onPart = (part: Part): ReadonlyArray<AdapterEvent> => {
        const state = liveOf(part.sessionID)
        const threadId = part.sessionID
        if (part.type === 'tool') return [{ type: 'block', threadId, block: toolCallout(part) }]
        if (part.type !== 'text' && part.type !== 'file') return []
        if (state.own.has(part.messageID)) return []
        if (state.roles.get(part.messageID) === 'user') {
          const parts = state.foreign.get(part.messageID) ?? new Map<string, Part>()
          parts.set(part.id, part)
          state.foreign.set(part.messageID, parts)
          const block = userBlock(part.messageID, [...parts.values()])
          return block ? [{ type: 'block', threadId, block }] : []
        }
        if (part.type !== 'text' || part.synthetic || part.ignored) return []
        const texts = state.texts.get(part.messageID) ?? new Map<string, string>()
        texts.set(part.id, part.text)
        state.texts.set(part.messageID, texts)
        const text = joinAgentText(texts.values())
        return text ? [{ type: 'block', threadId, block: { kind: 'agent', id: part.messageID, text } }] : []
      }

      const onDelta = (
        sessionId: string,
        messageID: string,
        partID: string,
        delta: string,
      ): ReadonlyArray<AdapterEvent> => {
        // Only an announced, visible text part streams; reasoning deltas share `field: 'text'` and never show.
        const texts = live.get(sessionId)?.texts.get(messageID)
        const previous = texts?.get(partID)
        if (!texts || previous === undefined || !delta) return []
        texts.set(partID, previous + delta)
        const last = [...texts.keys()].pop() === partID
        // The tail grows in place when this part already shows, or when it is the only text so far.
        const appends = last && (previous !== '' || [...texts].every(([id, text]) => id === partID || !text))
        if (appends)
          return [{ type: 'text', threadId: sessionId, blockId: messageID, delta, create: { kind: 'agent' } }]
        // A new paragraph (or an earlier part growing) changes more than the tail: send the whole block.
        return [
          {
            type: 'block',
            threadId: sessionId,
            block: { kind: 'agent', id: messageID, text: joinAgentText(texts.values()) },
          },
        ]
      }

      const onUserMessage = (sessionId: string, id: string) => {
        const state = liveOf(sessionId)
        state.roles.set(id, 'user')
        if (state.pendingEcho === null) return
        // A server that ignored the id Docs sent still owns this message: the echo stands for it.
        if (id !== state.pendingEcho) state.own.add(id)
        state.pendingEcho = null
      }

      const onReplied = (requestID: string, resolved: 'accepted' | 'skipped'): Effect.Effect<void> => {
        const blockId = permissionBlockId(requestID)
        const pending = approvals.get(blockId)
        approvals.delete(blockId)
        // A request still being routed was never shown: nothing to resolve, and no lookup needed.
        if (answered.delete(requestID) || !pending || routing.has(blockId)) return Effect.void
        return resolveRoot(pending.sessionId).pipe(
          Effect.flatMap((root) => emit({ type: 'resolved', threadId: root ?? pending.sessionId, blockId, resolved })),
        )
      }

      let subscribed = false
      const connected = yield* Deferred.make<void>()
      const toEvents = (envelope: GlobalEvent): Effect.Effect<void> => {
        const event = envelope.payload
        switch (event.type) {
          case 'server.connected':
            if (subscribed) return logDefects(resync).pipe(Effect.forkIn(scope), Effect.asVoid)
            subscribed = true
            return Deferred.succeed(connected, undefined).pipe(Effect.asVoid)
          case 'message.updated':
            if (event.properties.info.role === 'user')
              onUserMessage(event.properties.sessionID, event.properties.info.id)
            else liveOf(event.properties.sessionID).roles.set(event.properties.info.id, 'assistant')
            return Effect.void
          case 'message.part.updated':
            return emitAll(onPart(event.properties.part))
          case 'message.part.delta': {
            const { sessionID, messageID, partID, field, delta } = event.properties
            return field === 'text' ? emitAll(onDelta(sessionID, messageID, partID, delta)) : Effect.void
          }
          case 'session.status': {
            const { sessionID, status } = event.properties
            if (status.type === 'idle') return emitAll(endTurn(sessionID))
            if (busy.has(sessionID)) return Effect.void
            busy.add(sessionID)
            return emit({ type: 'turnStarted', threadId: sessionID })
          }
          case 'session.idle':
            return emitAll(endTurn(event.properties.sessionID))
          case 'session.error': {
            const { sessionID, error } = event.properties
            const aborted = error?.name === 'MessageAbortedError'
            const message = aborted ? undefined : readableProviderError(error)
            if (!sessionID) return message ? emit({ type: 'notice', message }) : Effect.void
            return emitAll(endTurn(sessionID, message))
          }
          case 'permission.asked': {
            const request = event.properties
            register('permission', request.id, request.sessionID)
            return routeRequest(request.sessionID, envelope.directory, permissionBlock(request))
          }
          case 'question.asked': {
            const request = event.properties
            register('question', request.id, request.sessionID, request.questions.length)
            return routeRequest(request.sessionID, envelope.directory, questionBlock(request))
          }
          case 'permission.replied':
            return onReplied(event.properties.requestID, event.properties.reply === 'reject' ? 'skipped' : 'accepted')
          case 'question.replied':
            return onReplied(event.properties.requestID, 'accepted')
          case 'question.rejected':
            return onReplied(event.properties.requestID, 'skipped')
          case 'session.created':
          case 'session.updated': {
            const info = event.properties.info
            directories.set(info.id, info.directory)
            if (info.parentID) {
              parents.set(info.id, info.parentID)
              return Effect.void
            }
            roots.add(info.id)
            if (event.type === 'session.created') return emit({ type: 'invalidate', part: 'docs' })
            if (!info.title || titles.get(info.id) === info.title) return Effect.void
            titles.set(info.id, info.title)
            return emit({ type: 'title', threadId: info.id, title: info.title })
          }
          case 'session.deleted':
            opened.delete(event.properties.info.id)
            busy.delete(event.properties.info.id)
            parents.delete(event.properties.info.id)
            return emitAll([
              { type: 'closed', threadId: event.properties.info.id },
              { type: 'invalidate', part: 'docs' },
            ])
          case 'project.updated':
            return emit({ type: 'invalidate', part: 'projects' })
          default:
            return Effect.void
        }
      }

      // One subscription: an attempt ends (and is retried) when the stream closes, fails, or goes
      // quiet past the watchdog. Out of retries, the session ends and the manager restarts the server.
      const subscription = Stream.unwrap(
        Effect.gen(function* () {
          const controller = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (abort) => Effect.sync(() => abort.abort()),
          )
          const result = yield* Effect.tryPromise({
            try: () => client.global.event({ signal: controller.signal, sseMaxRetryAttempts: 1 }),
            catch: () => streamLost('Docs could not subscribe to OpenCode updates'),
          })
          return Stream.fromAsyncIterable(result.stream, () => streamLost('OpenCode updates failed'))
        }),
      ).pipe(
        Stream.concat(Stream.fail(streamLost('OpenCode closed its update stream'))),
        Stream.timeoutOrElse({
          duration: WATCHDOG,
          orElse: () => Stream.fail(streamLost('OpenCode stopped sending updates')),
        }),
        Stream.retry(RESUBSCRIBE),
      )
      const streamEnded = yield* Deferred.make<never, ProviderError>()
      yield* subscription.pipe(
        Stream.runForEach(toEvents),
        // Any end but shutdown, a defect included, ends the session so the manager restarts it.
        Effect.catchCause((cause) => {
          const dies = Cause.hasDies(cause)
          if (Cause.hasInterrupts(cause) && !dies) return Effect.interrupt
          const error = Cause.findErrorOption(cause)
          if (Option.isSome(error) && !dies) return Deferred.fail(streamEnded, error.value)
          // A defect (say, in toEvents), even beside a failure, is logged under a report id;
          // the banner gets a plain sentence.
          return reportDefect(cause).pipe(
            Effect.flatMap((reportId) => Deferred.fail(streamEnded, new ProviderDefectError({ provider, reportId }))),
          )
        }),
        Effect.forkIn(scope),
      )
      yield* Deferred.await(connected).pipe(
        Effect.raceFirst(Deferred.await(streamEnded)),
        Effect.timeoutOrElse({
          duration: Duration.seconds(15),
          orElse: () => Effect.fail(new ProviderTimeoutError({ provider, operation: 'global.event', seconds: 15 })),
        }),
      )

      const session: ProviderSession = {
        events: Stream.fromQueue(events),
        awaitExit: server.awaitExit.pipe(Effect.raceFirst(Deferred.await(streamEnded))),

        loadCatalog: Effect.gen(function* () {
          const [providers, agents, projects] = yield* Effect.all(
            [
              request('config.providers', (signal) => client.config.providers({}, opts(signal))),
              request('app.agents', (signal) => client.app.agents({}, opts(signal))),
              request('project.list', (signal) => client.project.list({}, opts(signal))),
            ],
            { concurrency: 'unbounded' },
          )
          const models = toModels(providers.data.providers, providers.data.default)
          if (!models.length) return yield* Effect.fail(new NotLoggedInError({ provider, hint: NO_MODELS }))
          const modes = toModes(agents.data)
          return {
            account: null,
            requiresAuth: false,
            models,
            modes,
            defaultMode: defaultMode(modes),
            projects: toProjects(projects.data),
            tools: [],
          } satisfies Catalog
        }),

        listDocs: (search) =>
          Stream.paginate({ cursor: undefined as number | undefined, page: 0 }, ({ cursor, page }) =>
            request('experimental.session.list', (signal) =>
              client.experimental.session.list(
                {
                  roots: true,
                  limit: DOC_PAGE,
                  ...(search.trim() ? { search: search.trim() } : {}),
                  ...(cursor ? { cursor } : {}),
                },
                opts(signal),
              ),
            ).pipe(
              Effect.map((result) => {
                for (const item of result.data) {
                  directories.set(item.id, item.directory)
                  roots.add(item.id)
                }
                const nextCursor = Number(result.response.headers.get('x-next-cursor'))
                const next =
                  nextCursor && result.data.length === DOC_PAGE && page + 1 < MAX_DOC_PAGES
                    ? Option.some({ cursor: nextCursor, page: page + 1 })
                    : Option.none()
                return [[result.data.map(toDoc)], next] as const
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
          request('app.skills', (signal) => client.app.skills(cwd ? { directory: cwd } : {}, opts(signal))).pipe(
            Effect.map((result) => {
              const skills = new Map<string, Skill>()
              for (const skill of result.data) {
                skillBodies.set(skill.name, { location: skill.location, content: skill.content })
                if (!skills.has(skill.name)) {
                  skills.set(skill.name, {
                    name: skill.name,
                    description: skill.description ?? '',
                    path: skill.location,
                  })
                }
              }
              return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
            }),
          ),

        openThread: (threadId, hint) =>
          Effect.gen(function* () {
            if (hint?.cwd) directories.set(threadId, hint.cwd)
            const info = yield* request('session.get', (signal) =>
              client.session.get({ sessionID: threadId, directory: dir(threadId) }, opts(signal)),
            )
            directories.set(threadId, info.data.directory)
            if (!info.data.parentID) roots.add(threadId)
            if (info.data.title) titles.set(threadId, info.data.title)
            const [page, streaming, pending] = yield* Effect.all(
              [messagesPage(threadId), isBusy(threadId), pendingFor(threadId)],
              { concurrency: 'unbounded' },
            )
            live.delete(threadId)
            seed(threadId, page.messages)
            if (streaming) busy.add(threadId)
            else busy.delete(threadId)
            opened.add(threadId)
            const model = info.data.model
            const agent = info.data.agent && info.data.agent.toLowerCase() !== 'plan' ? info.data.agent : null
            return {
              threadId,
              title: sessionTitle(info.data.title, page.messages),
              blocks: [...blocksFromMessages(page.messages), ...pending],
              olderCursor: page.cursor,
              cwd: info.data.directory,
              settings: {
                ...(model ? { model: modelKey(model.providerID, model.id) } : {}),
                ...(agent ? { mode: agent } : {}),
              },
              streaming,
            } satisfies OpenedThread
          }),

        createThread: (options) =>
          Effect.gen(function* () {
            const model = options.settings.model ? splitModelKey(options.settings.model) : null
            const created = yield* request('session.create', (signal) =>
              client.session.create(
                {
                  directory: options.cwd,
                  ...(options.title ? { title: options.title } : {}),
                  ...(options.settings.mode ? { agent: options.settings.mode } : {}),
                  ...(model ? { model: { id: model.modelID, providerID: model.providerID } } : {}),
                },
                opts(signal),
              ),
            )
            const threadId = created.data.id
            directories.set(threadId, created.data.directory || options.cwd)
            opened.add(threadId)
            return {
              threadId,
              title: options.title || 'Untitled document',
              blocks: [],
              olderCursor: null,
              cwd: created.data.directory || options.cwd,
            } satisfies OpenedThread
          }),

        loadOlder: (threadId, cursor) =>
          messagesPage(threadId, cursor).pipe(
            Effect.map((page) => ({ blocks: blocksFromMessages(page.messages), cursor: page.cursor })),
          ),

        messageId,

        send: (threadId, input, settings) =>
          Effect.gen(function* () {
            const model = settings.model ? splitModelKey(settings.model) : null
            if (!model) return yield* Effect.fail(rejected('session.prompt_async', 'Pick a model first.'))
            const skill = input.skill
              ? (skillBodies.get(input.skill.name) ?? { location: input.skill.path, content: '' })
              : null
            const parts = yield* Effect.try({
              try: () => [
                ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
                ...(skill && input.skill
                  ? [
                      skillPart({
                        name: input.skill.name,
                        location: skill.location,
                        content: skill.content || readFileSync(skill.location, 'utf8'),
                      }),
                    ]
                  : []),
                ...input.images.map(imagePart),
              ],
              catch: () => rejected('session.prompt_async', 'Docs could not read an attached file.'),
            })
            const state = liveOf(threadId)
            state.own.add(input.clientId)
            state.pendingEcho = input.clientId
            yield* request(
              'session.prompt_async',
              (signal) =>
                client.session.promptAsync(
                  {
                    sessionID: threadId,
                    directory: dir(threadId),
                    messageID: input.clientId,
                    model,
                    ...(settings.mode ? { agent: settings.mode } : {}),
                    parts,
                  },
                  opts(signal),
                ),
              60,
            ).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  state.own.delete(input.clientId)
                  state.pendingEcho = null
                }),
              ),
            )
          }),

        // Aborting a session leaves its subagents running, so they are stopped after it.
        interrupt: (threadId) =>
          request('session.abort', (signal) =>
            client.session.abort({ sessionID: threadId, directory: dir(threadId) }, opts(signal)),
          ).pipe(Effect.andThen(abortDescendants(threadId))),

        respond: (_threadId, approvalId, reply) =>
          Effect.gen(function* () {
            const pending = approvals.get(approvalId)
            if (!pending)
              return yield* Effect.fail(rejected('respond', 'This request is no longer waiting for an answer.'))
            const directory = dir(pending.sessionId) ?? dir(climb(pending.sessionId))
            const requestID = pending.requestId
            answered.add(requestID)
            const answers = Array.from({ length: pending.questions }, (_, index) => {
              const value = reply.answers[questionId(index)]?.trim()
              return value ? [value] : []
            })
            const taken = yield* (
              pending.kind === 'permission'
                ? request('permission.reply', (signal) =>
                    client.permission.reply(
                      { requestID, directory, reply: reply.accept ? 'once' : 'reject' },
                      opts(signal),
                    ),
                  )
                : reply.accept
                  ? request('question.reply', (signal) =>
                      client.question.reply({ requestID, directory, answers }, opts(signal)),
                    )
                  : request('question.reject', (signal) =>
                      client.question.reject({ requestID, directory }, opts(signal)),
                    )
            ).pipe(Effect.tapError(() => Effect.sync(() => answered.delete(requestID))))
            // The server answers `false` when the request already settled or never existed.
            if (taken.data !== true) {
              answered.delete(requestID)
              return yield* Effect.fail(rejected('respond', 'OpenCode did not take that answer. Try again.'))
            }
            approvals.delete(approvalId)
          }),

        rename: (threadId, name) =>
          request('session.update', (signal) =>
            client.session.update({ sessionID: threadId, directory: dir(threadId), title: name }, opts(signal)),
          ).pipe(
            Effect.tap(() => Effect.sync(() => titles.set(threadId, name))),
            Effect.asVoid,
          ),

        releaseThread: (threadId) =>
          Effect.sync(() => {
            opened.delete(threadId)
            live.delete(threadId)
          }),

        createProject: (name, cwd) =>
          Effect.gen(function* () {
            const current = yield* request('project.current', (signal) =>
              client.project.current({ directory: cwd }, opts(signal)),
            )
            if (current.data.id === 'global') {
              return yield* Effect.fail(
                rejected(
                  'project.update',
                  'Choose a Git project folder. Other folders can be used with “Choose folder” when creating a document.',
                ),
              )
            }
            yield* request('project.update', (signal) =>
              client.project.update({ projectID: current.data.id, directory: cwd, name }, opts(signal)),
            )
          }),
      }
      return session
    }),
  }
}

/**
 * The `opencode server listening on http://…` line `opencode serve` prints once it accepts requests.
 * Adapted from T3 Code (packages/provider-opencode/src/server/OpenCodeRuntime.ts) at commit 8a14762c.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
export function parseServerUrl(output: string): string | null {
  for (const line of output.split('\n')) {
    const match = /server listening on\s+(https?:\/\/[^\s]+)/i.exec(line)
    if (match?.[1]) return match[1].replace(/\/$/, '')
  }
  return null
}

/**
 * The real backend: `opencode serve` on a loopback port the OS picks, under the
 * process supervisor, protected by a per-launch password so no other local
 * process can drive it. Readiness is the "listening on" line (T3 Code's
 * approach); stdout keeps draining so a chatty server never blocks on a full pipe.
 */
export const spawnServer = (supervisor: ProcessSupervisor['Service']): Connect =>
  Effect.gen(function* () {
    const password = randomBytes(24).toString('base64url')
    const child = yield* supervisor.spawn(
      {
        provider,
        command: process.env.OPENCODE_BIN || 'opencode',
        args: ['serve', '--hostname=127.0.0.1', '--port=0'],
        cwd: process.env.HOME || undefined,
        env: { OPENCODE_SERVER_PASSWORD: password },
      },
      true,
    )
    const ready = yield* Deferred.make<string>()
    let output: string | null = ''
    yield* child.handle.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          if (output === null) return Effect.void
          output = (output + chunk).slice(-64 * 1024)
          const url = parseServerUrl(output)
          if (!url) return Effect.void
          output = null
          return Deferred.succeed(ready, url)
        }),
      ),
      Effect.ignore,
      // A defect here is logged; the wait below then ends with the serve timeout.
      logDefects,
      Effect.forkScoped,
    )
    const url = yield* Deferred.await(ready).pipe(
      Effect.raceFirst(child.awaitExit),
      Effect.timeoutOrElse({
        duration: Duration.seconds(SERVER_READY),
        orElse: () => Effect.fail(new ProviderTimeoutError({ provider, operation: 'serve', seconds: SERVER_READY })),
      }),
    )
    return {
      url,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
      awaitExit: child.awaitExit,
    } satisfies Server
  })
