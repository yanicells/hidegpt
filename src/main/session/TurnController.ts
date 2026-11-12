// Adapted from T3 Code (apps/server/src/orchestration-v2/ProviderTurnControlService.ts,
// ProviderTurnStartService.ts and RuntimeRequestService.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FiberMap from 'effect/FiberMap'
import type * as Scope from 'effect/Scope'
import * as SubscriptionRef from 'effect/SubscriptionRef'

import type { Command } from '../../shared/contracts'
import type { ProviderId } from '../../shared/model'
import { CommandRejectedError, type ProviderError, ProviderNotReadyError } from '../../provider/errors'
import type { RequestStatus, TurnId, UserItem } from '../../provider/events'
import { observed, undoOnFailure } from '../../provider/observed'
import type { ProviderSession, TurnSettings } from '../../provider/ProviderAdapter'
import { randomUuidV4 } from '../../provider/randomUuid'
import { setRequestStatus } from './items'
import * as S from './state'

/**
 * Starts, stops and answers turns (T3 Code's turn start, turn control and
 * runtime request services, reduced to one document per provider thread).
 *
 * - Every command names its document. A handler acts on that runtime or
 *   rejects; it never falls back to whatever the window shows now (T3's
 *   invariant: every command targets app ids).
 * - Opening a turn is one state write that checks no turn is open, opens it
 *   and adds the echo, so two sends can never both pass the check.
 * - Stop is answered. A refused stop restores the turn and fails the command
 *   (the banner says why). An accepted stop waits `STOP_SETTLE` for the
 *   provider's terminal; past that the turn ends here as interrupted and the
 *   document re-reads on its next open, since the provider's work may still be
 *   running (T3's `unresponsive` case).
 */

/** How long an accepted stop waits for the provider to end the turn. */
export const STOP_SETTLE = Duration.seconds(10)

/** A command's document: the fields every targeted command carries. */
export type Target = { readonly provider: ProviderId; readonly threadId: string }

type TurnError = ProviderError | CommandRejectedError

const rejected = (reason: string) => new CommandRejectedError({ reason })
const GONE = 'That document is no longer open.'

/** The named runtime, or the rejection the renderer shows when it is gone. */
export const runtimeOf = (
  state: SubscriptionRef.SubscriptionRef<S.State>,
  target: Target,
): Effect.Effect<S.ThreadRuntime, CommandRejectedError> =>
  Effect.flatMap(SubscriptionRef.get(state), (current) => {
    const runtime = current.runtimes.get(S.keyOf(target.provider, target.threadId))
    return runtime ? Effect.succeed(runtime) : Effect.fail(rejected(GONE))
  })

export interface TurnControllerOptions {
  readonly state: SubscriptionRef.SubscriptionRef<S.State>
  /** Waits until the provider is connected, starting it if needed. */
  readonly ready: (provider: ProviderId) => Effect.Effect<ProviderSession, ProviderNotReadyError>
  /** The provider's session if it is connected now. A stop never waits for a reconnect. */
  readonly live: (provider: ProviderId) => ProviderSession | undefined
}

export interface TurnController {
  readonly send: (command: Extract<Command, { op: 'send' }>) => Effect.Effect<void, TurnError>
  readonly interrupt: (command: Extract<Command, { op: 'interrupt' }>) => Effect.Effect<void, TurnError>
  readonly resolveApproval: (command: Extract<Command, { op: 'resolveApproval' }>) => Effect.Effect<void, TurnError>
}

/** What a turn-opening write decided: the settings to send with, or why not. */
type Opened = { readonly ok: true; readonly settings: TurnSettings } | { readonly ok: false; readonly reason: string }

export const make = (options: TurnControllerOptions): Effect.Effect<TurnController, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { state } = options
    /** One settle deadline per stopped turn, keyed by runtime and turn id. */
    const deadlines = yield* FiberMap.make<string>()
    const update = (f: (current: S.State) => S.State) => SubscriptionRef.update(state, f)

    const send = (command: Extract<Command, { op: 'send' }>) =>
      Effect.gen(function* () {
        const { provider, threadId } = command
        const key = S.keyOf(provider, threadId)
        yield* runtimeOf(state, command)
        const text = command.text.trim()
        const images = command.images ?? []
        const skills = (yield* SubscriptionRef.get(state)).libraries[provider].skills
        const skill = command.skill ? (skills.find((item) => item.name === command.skill) ?? null) : null
        if (!text && images.length === 0 && !skill) return yield* Effect.fail(rejected('There is nothing to send.'))
        const session = yield* options.ready(provider)
        const clientId = session.messageId()
        // The turn's app id: every event for this turn carries it, so nothing from another turn can end it.
        const turnId = yield* randomUuidV4
        const echo: UserItem = {
          kind: 'user',
          id: clientId,
          text,
          ...(images.length ? { images } : {}),
          ...(skill ? { skills: [skill.name] } : {}),
        }
        const at = yield* Clock.currentTimeMillis
        // The check and the write are one step: a second send in the same tick sees this turn.
        const opened = yield* SubscriptionRef.modify(state, (current): readonly [Opened, S.State] => {
          const runtime = current.runtimes.get(key)
          if (!runtime) return [{ ok: false, reason: GONE }, current]
          if (runtime.turn) {
            return [{ ok: false, reason: 'Wait for the current answer to finish, or stop it first.' }, current]
          }
          const next = S.updateRuntime(current, key, (item) => ({
            ...item,
            items: [...item.items, echo],
            turn: { id: turnId, phase: 'starting' },
            touchedAt: at,
          }))
          const lib = current.libraries[provider]
          return [
            { ok: true, settings: lib.settings },
            S.updateLibrary(next, provider, (latest) => ({ ...latest, error: null })),
          ]
        })
        if (!opened.ok) return yield* Effect.fail(rejected(opened.reason))
        yield* session.send(threadId, turnId, { text, images, skill, clientId }, opened.settings).pipe(
          undoOnFailure(() =>
            update((current) =>
              S.updateRuntime(current, key, (item) => ({
                ...item,
                turn: item.turn?.id === turnId ? null : item.turn,
                items: item.items.filter((entry) => entry.id !== clientId),
              })),
            ),
          ),
        )
      })

    /** The stopped turn, if it is still open past the deadline, ends here and the document re-reads next time. */
    const settle = (key: string, provider: ProviderId, threadId: string, turnId: TurnId) =>
      Effect.gen(function* () {
        yield* Effect.sleep(STOP_SETTLE)
        const at = yield* Clock.currentTimeMillis
        const settled = yield* SubscriptionRef.modify(state, (current): readonly [boolean, S.State] => {
          if (current.runtimes.get(key)?.turn?.id !== turnId) return [false, current]
          const ended = S.applyThreadEvent(
            current,
            provider,
            { type: 'turn.ended', threadId, turnId, status: 'interrupted', failure: null },
            at,
          )
          return [true, S.updateRuntime(ended, key, (item) => ({ ...item, stale: true }))]
        })
        if (settled) {
          yield* Effect.logWarning('Stop not confirmed; its processes may still be running').pipe(
            Effect.annotateLogs({ provider, threadId, turnId }),
          )
        }
      })

    const interrupt = (command: Extract<Command, { op: 'interrupt' }>) =>
      Effect.gen(function* () {
        const { provider, threadId } = command
        const key = S.keyOf(provider, threadId)
        yield* runtimeOf(state, command)
        const session = options.live(provider)
        if (!session) return yield* Effect.fail(new ProviderNotReadyError({ provider, detail: null }))
        // One write moves the open turn to stopping. Nothing open, or already stopping: nothing to do,
        // so a Stop that crosses the answer's end is not an error.
        const stopping = yield* SubscriptionRef.modify(state, (current): readonly [S.OpenTurn | null, S.State] => {
          const turn = current.runtimes.get(key)?.turn
          if (!turn || turn.phase === 'stopping') return [null, current]
          return [turn, S.updateRuntime(current, key, (item) => ({ ...item, turn: { ...turn, phase: 'stopping' } }))]
        })
        if (!stopping) return
        yield* session.interrupt(threadId, stopping.id).pipe(
          // Refused: the turn goes back to what it was, if nothing has moved it since.
          undoOnFailure(() =>
            update((current) =>
              S.updateRuntime(current, key, (item) =>
                item.turn?.id === stopping.id && item.turn.phase === 'stopping' ? { ...item, turn: stopping } : item,
              ),
            ),
          ),
        )
        // Nobody joins the deadline, so it reports its own failures.
        yield* FiberMap.run(
          deadlines,
          `${key}#${stopping.id}`,
          observed(settle(key, provider, threadId, stopping.id), { name: 'turns.settleStop' }),
          { onlyIfMissing: true },
        ).pipe(Effect.asVoid)
      })

    const resolveApproval = (command: Extract<Command, { op: 'resolveApproval' }>) =>
      Effect.gen(function* () {
        const runtime = yield* runtimeOf(state, command)
        const request = runtime.items.find((item) => item.id === command.blockId)
        if (!request || request.kind !== 'request' || request.status !== 'pending') return
        const session = yield* options.ready(command.provider)
        const key = S.keyOf(command.provider, command.threadId)
        /** Moves the request to `status`, unless `from` is given and it has moved on since (it expired). */
        const mark = (status: RequestStatus, from?: RequestStatus) =>
          update((current) =>
            S.updateRuntime(current, key, (item) => {
              const now = item.items.find((entry) => entry.id === command.blockId)
              if (from && (now?.kind !== 'request' || now.status !== from)) return item
              return { ...item, items: setRequestStatus(item.items, command.blockId, status) }
            }),
          )
        yield* mark('sending')
        yield* session
          .respond(command.threadId, command.blockId, { accept: command.accept, answers: command.answers ?? {} })
          .pipe(undoOnFailure(() => mark('pending', 'sending')))
        // A turn that ended while the reply was on its way already expired the request.
        yield* mark(command.accept ? 'accepted' : 'declined', 'sending')
      })

    return { send, interrupt, resolveApproval }
  })
