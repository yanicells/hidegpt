// The pending-turn registration (a turn exists before its start request returns, and the start
// response and the start notification race to confirm it) is adapted from T3 Code
// (https://github.com/pingdotgg/t3code), apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts
// (`pendingRootTurns`, `registerRootTurn`) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Semaphore from 'effect/Semaphore'

import type { ProviderId } from '../shared/model'
import { ProviderRequestError, ProviderTimeoutError } from './errors'
import type { Failure, ThreadEvent, TurnId, TurnStatus } from './events'
import { randomUuidV4 } from './randomUuid'

/**
 * The turn bookkeeping every adapter shares, so none keeps its own: which turn
 * is open on each thread, its provider-native id, whether it has started, and
 * whether the person asked to stop it. It emits `turn.started` and
 * `turn.ended` itself, so each turn gets exactly one of each.
 *
 * State is a plain Map behind a one-permit semaphore rather than a `Ref`, so
 * `current` can stay synchronous for adapters stamping items. Every change and
 * the event it emits happen under the permit, so events leave in the same order
 * as the changes they report.
 */
export interface TurnTracker {
  /** `send` calls this before the native request. Fails if a turn is already running on the thread. */
  readonly begin: (threadId: string, turnId: TurnId) => Effect.Effect<void, ProviderRequestError>
  /**
   * The native start signal: the start response or the start notification, whichever comes
   * first. Idempotent. Without `turnId` (a notification), a thread with no open turn adopts
   * one (a turn started elsewhere), unless `nativeTurnId` names a turn that already ended
   * here. With it (the start response, which knows its turn), only that turn is confirmed,
   * and its `nativeTurnId` is the one that counts, even over an id remembered as ended. If
   * that turn already closed, the id is remembered as ended, so the turn's later events can't
   * come back as the next turn's. That covers only the response arriving first: a closed
   * turn's start notification that beats its response is still adopted by the next turn.
   * ARCH-4a closes that, since its items and terminals carry the native id.
   */
  readonly started: (threadId: string, nativeTurnId: string | null, turnId?: TurnId) => Effect.Effect<void>
  /**
   * For Stop pressed right after send: resolves with the native turn id once the provider knows
   * the turn. Fails when that turn is not open (it already ended) or does not start in time.
   */
  readonly awaitStarted: (
    threadId: string,
    turnId: TurnId,
    timeout: Duration.Input,
  ) => Effect.Effect<string | null, ProviderTimeoutError | ProviderRequestError>
  /** Marks the open turn as stopped by the person. False when `turnId` is not the open turn. */
  readonly requestStop: (threadId: string, turnId: TurnId) => Effect.Effect<boolean>
  /**
   * Exactly-once: ends the open turn and emits `turn.ended`. A call with no open turn, or whose
   * `nativeTurnId` names a different native turn or one that already ended here, is dropped
   * and logged. A turn the person stopped that ends without a failure is `interrupted`,
   * whatever the provider called it. True when it ended the open turn.
   */
  readonly end: (threadId: string, outcome: TurnOutcome) => Effect.Effect<boolean>
  /** The native send failed: forget the turn without a terminal (the manager rolls back its echo). */
  readonly abandon: (threadId: string, turnId: TurnId) => Effect.Effect<void>
  /** The open turn's id, to stamp items with. */
  readonly current: (threadId: string) => TurnId | null
  /** A turn found already running (opened mid-answer, or after a re-sync). Returns its id, allocating one if new. */
  readonly adopt: (threadId: string, nativeTurnId: string | null) => Effect.Effect<TurnId>
  /** The session is closing: end every open turn as failed with `transport_error`. */
  readonly failAll: (detail: string) => Effect.Effect<void>
}

export type TurnOutcome = {
  readonly status: TurnStatus
  /** Required for `failed`; ignored otherwise. */
  readonly failure: Failure | null
  /** When the provider names the turn it ended, a terminal for another turn is dropped. */
  readonly nativeTurnId?: string | null
}

export type TurnTrackerOptions = {
  readonly provider: ProviderId
  readonly emit: (event: ThreadEvent) => Effect.Effect<void>
  /** Ids for adopted turns. Defaults to a `Random`-based UUID, so tests can seed it. */
  readonly allocateId?: Effect.Effect<TurnId>
}

type OpenTurn = {
  readonly turnId: TurnId
  nativeTurnId: string | null
  phase: 'starting' | 'running'
  stopRequested: boolean
  /** Succeeds with the native id on start; fails if the turn ends or is abandoned first. */
  readonly started: Deferred.Deferred<string | null, ProviderRequestError>
}

/** How many ended native turn ids each thread remembers, to drop their late events. */
const ENDED_MEMORY = 8

/** Used when a provider reports a failed turn without saying why. */
const UNKNOWN_FAILURE: Failure = { class: 'unknown', detail: '', retryable: null, resetAt: null }

export const makeTurnTracker = (options: TurnTrackerOptions): Effect.Effect<TurnTracker> =>
  Effect.gen(function* () {
    const { provider, emit } = options
    const allocateId = options.allocateId ?? randomUuidV4
    const lock = yield* Semaphore.make(1)
    const open = new Map<string, OpenTurn>()
    /** Native ids of the turns that ended on each thread, newest last. */
    const ended = new Map<string, ReadonlyArray<string>>()
    const remember = (threadId: string, nativeTurnId: string) =>
      void ended.set(threadId, [...(ended.get(threadId) ?? []), nativeTurnId].slice(-ENDED_MEMORY))
    const unremember = (threadId: string, nativeTurnId: string) =>
      void ended.set(
        threadId,
        (ended.get(threadId) ?? []).filter((id) => id !== nativeTurnId),
      )
    const hasEnded = (threadId: string, nativeTurnId: string | null | undefined) =>
      nativeTurnId != null && (ended.get(threadId)?.includes(nativeTurnId) ?? false)
    const dropped = (what: string, threadId: string) =>
      Effect.logDebug(`Dropped a ${what} for a turn that is not open`).pipe(Effect.annotateLogs({ threadId }))

    const notRunning = (operation: string) =>
      new ProviderRequestError({ provider, operation, detail: 'Nothing is running in this document.' })

    const close = (threadId: string, turn: OpenTurn, outcome: TurnOutcome) =>
      Effect.gen(function* () {
        open.delete(threadId)
        if (turn.nativeTurnId !== null) remember(threadId, turn.nativeTurnId)
        yield* Deferred.fail(turn.started, notRunning('interrupt'))
        const status: TurnStatus = outcome.status === 'completed' && turn.stopRequested ? 'interrupted' : outcome.status
        yield* emit({
          type: 'turn.ended',
          threadId,
          turnId: turn.turnId,
          status,
          failure: status === 'failed' ? (outcome.failure ?? UNKNOWN_FAILURE) : null,
        })
      })

    /** Moves the thread's turn to running (adopting one if none is open) and returns its id. */
    const markStarted = (threadId: string, nativeTurnId: string | null) =>
      Effect.gen(function* () {
        const turn = open.get(threadId)
        if (!turn) {
          const turnId = yield* allocateId
          const started = yield* Deferred.make<string | null, ProviderRequestError>()
          yield* Deferred.succeed(started, nativeTurnId)
          open.set(threadId, { turnId, nativeTurnId, phase: 'running', stopRequested: false, started })
          yield* emit({ type: 'turn.started', threadId, turnId })
          return turnId
        }
        if (nativeTurnId !== null && turn.nativeTurnId === null) turn.nativeTurnId = nativeTurnId
        if (turn.phase === 'starting') {
          turn.phase = 'running'
          yield* Deferred.succeed(turn.started, turn.nativeTurnId)
          yield* emit({ type: 'turn.started', threadId, turnId: turn.turnId })
        }
        return turn.turnId
      })

    const begin = (threadId: string, turnId: TurnId) =>
      lock.withPermit(
        Effect.gen(function* () {
          const previous = open.get(threadId)
          if (previous && !previous.stopRequested) {
            return yield* Effect.fail(
              new ProviderRequestError({
                provider,
                operation: 'send',
                detail: 'Wait for the current answer to finish, or stop it first.',
              }),
            )
          }
          // A stopped turn whose terminal never came must not block the next message.
          if (previous) {
            yield* Effect.logWarning('A stopped turn never ended; closing it for the next one').pipe(
              Effect.annotateLogs({ threadId, turnId: previous.turnId }),
            )
            yield* close(threadId, previous, { status: 'interrupted', failure: null })
          }
          const started = yield* Deferred.make<string | null, ProviderRequestError>()
          open.set(threadId, { turnId, nativeTurnId: null, phase: 'starting', stopRequested: false, started })
        }),
      )

    const end = (threadId: string, outcome: TurnOutcome) =>
      lock.withPermit(
        Effect.gen(function* () {
          const turn = open.get(threadId)
          const otherTurn =
            turn !== undefined &&
            outcome.nativeTurnId != null &&
            turn.nativeTurnId !== null &&
            outcome.nativeTurnId !== turn.nativeTurnId
          if (!turn || otherTurn || hasEnded(threadId, outcome.nativeTurnId)) {
            yield* dropped('terminal', threadId)
            return false
          }
          yield* close(threadId, turn, outcome)
          return true
        }),
      )

    return {
      begin,
      started: (threadId, nativeTurnId, turnId) =>
        lock.withPermit(
          Effect.suspend(() => {
            const turn = open.get(threadId)
            if (turnId !== undefined) {
              if (turn?.turnId !== turnId) {
                // A late response for a turn that already closed: its native events must not land on the next one.
                if (nativeTurnId !== null && !hasEnded(threadId, nativeTurnId)) remember(threadId, nativeTurnId)
                return Effect.void
              }
              if (nativeTurnId !== null) {
                // The response is authoritative: an id it names is this turn's, even if remembered as ended.
                unremember(threadId, nativeTurnId)
                turn.nativeTurnId = nativeTurnId
              }
            } else if (hasEnded(threadId, nativeTurnId)) {
              return dropped('start', threadId)
            }
            return Effect.asVoid(markStarted(threadId, nativeTurnId))
          }),
        ),
      adopt: (threadId, nativeTurnId) => lock.withPermit(markStarted(threadId, nativeTurnId)),
      awaitStarted: (threadId, turnId, timeout) =>
        Effect.suspend(() => {
          const turn = open.get(threadId)
          if (!turn || turn.turnId !== turnId) return Effect.fail(notRunning('interrupt'))
          return Deferred.await(turn.started).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  new ProviderTimeoutError({
                    provider,
                    operation: 'interrupt',
                    seconds: Duration.toSeconds(Duration.fromInputUnsafe(timeout)),
                  }),
                ),
            }),
          )
        }),
      requestStop: (threadId, turnId) =>
        lock.withPermit(
          Effect.sync(() => {
            const turn = open.get(threadId)
            if (!turn || turn.turnId !== turnId) return false
            turn.stopRequested = true
            return true
          }),
        ),
      end,
      abandon: (threadId, turnId) =>
        lock.withPermit(
          Effect.suspend(() => {
            const turn = open.get(threadId)
            if (!turn || turn.turnId !== turnId) return Effect.void
            open.delete(threadId)
            return Effect.asVoid(Deferred.fail(turn.started, notRunning('interrupt')))
          }),
        ),
      current: (threadId) => open.get(threadId)?.turnId ?? null,
      failAll: (detail) =>
        lock.withPermit(
          Effect.forEach(
            [...open],
            ([threadId, turn]) =>
              close(threadId, turn, {
                status: 'failed',
                failure: { class: 'transport_error', detail, retryable: true, resetAt: null },
              }),
            { discard: true },
          ),
        ),
    }
  })
