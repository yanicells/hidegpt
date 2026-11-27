import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'
import * as SubscriptionRef from 'effect/SubscriptionRef'

import { ProviderNotReadyError } from '../../provider/errors'
import type { OpenedThread } from '../../provider/ProviderAdapter'
import * as S from './state'
import * as TurnController from './TurnController'

const doc = { provider: 'codex', threadId: 'thr_1' } as const
const opened: OpenedThread = {
  threadId: 'thr_1',
  title: 'thr_1',
  items: [],
  olderCursor: null,
  cwd: '/tmp/docs',
  activeTurnId: null,
}

/** Codex showing `thr_1`, with `turn-1` running when `running`. */
const stateWith = (running: boolean) => {
  const shown = S.showThread(
    S.adopt(
      S.initialState('codex', () => '/tmp/docs'),
      'codex',
      opened,
      0,
    ),
    'codex',
    'thr_1',
  )
  return running
    ? S.applyThreadEvent(shown, 'codex', { type: 'turn.started', threadId: 'thr_1', turnId: 'turn-1' }, 1)
    : shown
}

/** A controller whose provider has no live session: the connection just dropped. */
const disconnected = (running: boolean) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(stateWith(running))
    const turns = yield* TurnController.make({
      state,
      ready: (provider) => Effect.fail(new ProviderNotReadyError({ provider, detail: null })),
      live: () => undefined,
    })
    return { state, turns }
  })

/** Warnings (message and annotations), instead of the console. */
const captureWarnings = () => {
  const logged: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
  const capture = Logger.make(({ message, fiber, logLevel }) => {
    if (logLevel === 'Warn') logged.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) })
  })
  return { logged, layer: Logger.layer([capture]) }
}

describe('TurnController: Stop with no live session', () => {
  it.effect('with no turn open, there is nothing to stop, so it succeeds', () =>
    Effect.gen(function* () {
      const { turns } = yield* disconnected(false)
      yield* turns.interrupt({ op: 'interrupt', ...doc })
    }),
  )

  it.effect("with a turn open, it fails in Docs' words, logs why by its fields, and leaves the turn", () => {
    const { logged, layer } = captureWarnings()
    return Effect.gen(function* () {
      const { state, turns } = yield* disconnected(true)
      const error = yield* Effect.flip(turns.interrupt({ op: 'interrupt', ...doc }))
      expect(error).toMatchObject({ _tag: 'CommandRejectedError', message: TurnController.STOP_FAILED })
      expect(logged).toEqual([
        {
          message: ['Stop refused'],
          annotations: { error: 'ProviderNotReadyError', provider: 'codex' },
        },
      ])
      const turn = (yield* SubscriptionRef.get(state)).runtimes.get(S.keyOf('codex', 'thr_1'))?.turn
      expect(turn).toEqual({ id: 'turn-1', phase: 'running' })
    }).pipe(Effect.provide(layer))
  })
})
