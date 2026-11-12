import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'

import type { ThreadEvent } from './events'
import { makeTurnTracker } from './turnTracker'

/** A tracker that records what it emits; adopted turns get ids `adopted-1`, `adopted-2`, … */
const setup = Effect.gen(function* () {
  const emitted: ThreadEvent[] = []
  let adopted = 0
  const tracker = yield* makeTurnTracker({
    provider: 'codex',
    emit: (event) => Effect.sync(() => emitted.push(event)),
    allocateId: Effect.sync(() => `adopted-${++adopted}`),
  })
  const types = () => emitted.map((event) => (event.type === 'turn.ended' ? `ended:${event.status}` : event.type))
  return { tracker, emitted, types }
})

describe('TurnTracker', () => {
  it.effect('starts a turn once, whichever of notification and response comes first', () =>
    Effect.gen(function* () {
      const { tracker, types } = yield* setup
      yield* tracker.begin('t', 'turn-1')
      yield* tracker.started('t', 'native-1')
      yield* tracker.started('t', null, 'turn-1')
      expect(types()).toEqual(['turn.started'])
      expect(tracker.current('t')).toBe('turn-1')
    }),
  )

  it.effect('ends a turn exactly once, and a late start response does not bring it back', () =>
    Effect.gen(function* () {
      const { tracker, types } = yield* setup
      yield* tracker.begin('t', 'turn-1')
      yield* tracker.started('t', 'native-1')
      yield* tracker.end('t', { status: 'completed', failure: null })
      yield* tracker.end('t', { status: 'failed', failure: null })
      yield* tracker.started('t', 'native-1', 'turn-1')
      expect(types()).toEqual(['turn.started', 'ended:completed'])
      expect(tracker.current('t')).toBeNull()
    }),
  )

  it.effect('drops a terminal that names another native turn', () =>
    Effect.gen(function* () {
      const { tracker, types } = yield* setup
      yield* tracker.begin('t', 'turn-2')
      yield* tracker.started('t', 'native-2')
      yield* tracker.end('t', { status: 'completed', failure: null, nativeTurnId: 'native-1' })
      expect(types()).toEqual(['turn.started'])
    }),
  )

  it.effect('a stopped turn’s late start response keeps its events off the next turn', () =>
    Effect.gen(function* () {
      const { tracker, types } = yield* setup
      yield* tracker.begin('t', 'turn-a')
      yield* tracker.requestStop('t', 'turn-a')
      yield* tracker.begin('t', 'turn-b')
      // A's start response, then its notifications, arrive after B began.
      yield* tracker.started('t', 'native-a', 'turn-a')
      yield* tracker.started('t', 'native-a')
      yield* tracker.end('t', { status: 'completed', failure: null, nativeTurnId: 'native-a' })
      expect(types()).toEqual(['ended:interrupted'])
      expect(tracker.current('t')).toBe('turn-b')
    }),
  )

  it.effect('a start response naming an id remembered as ended still owns its turn', () =>
    Effect.gen(function* () {
      const { tracker, types } = yield* setup
      yield* tracker.begin('t', 'turn-a')
      yield* tracker.started('t', 'native-x')
      yield* tracker.end('t', { status: 'completed', failure: null })
      yield* tracker.begin('t', 'turn-b')
      yield* tracker.started('t', 'native-x', 'turn-b')
      yield* tracker.end('t', { status: 'completed', failure: null, nativeTurnId: 'native-x' })
      expect(types()).toEqual(['turn.started', 'ended:completed', 'turn.started', 'ended:completed'])
      expect(tracker.current('t')).toBeNull()
    }),
  )

  it.effect('adopts a turn started elsewhere, and fills a failure the provider left out', () =>
    Effect.gen(function* () {
      const { tracker, emitted } = yield* setup
      yield* tracker.started('t', 'native-9')
      expect(tracker.current('t')).toBe('adopted-1')
      yield* tracker.end('t', { status: 'failed', failure: null })
      expect(emitted.at(-1)).toMatchObject({ turnId: 'adopted-1', status: 'failed', failure: { class: 'unknown' } })
    }),
  )

  it.effect('a stopped turn ends as interrupted, and the next send closes one that never ended', () =>
    Effect.gen(function* () {
      const { tracker, types } = yield* setup
      yield* tracker.begin('t', 'turn-1')
      const refused = yield* Effect.flip(tracker.begin('t', 'turn-2'))
      expect(refused.detail).toBe('Wait for the current answer to finish, or stop it first.')

      expect(yield* tracker.requestStop('t', 'turn-1')).toBe(true)
      yield* tracker.begin('t', 'turn-2')
      expect(tracker.current('t')).toBe('turn-2')

      yield* tracker.requestStop('t', 'turn-2')
      yield* tracker.end('t', { status: 'completed', failure: null })
      expect(types()).toEqual(['ended:interrupted', 'ended:interrupted'])
    }),
  )

  it.effect('waits for a turn to start before stopping it, up to a timeout', () =>
    Effect.gen(function* () {
      const { tracker } = yield* setup
      yield* tracker.begin('t', 'turn-1')
      const waiting = yield* Effect.forkChild(tracker.awaitStarted('t', 'turn-1', '10 seconds'))
      yield* tracker.started('t', 'native-1')
      expect(yield* Fiber.join(waiting)).toBe('native-1')

      yield* tracker.end('t', { status: 'completed', failure: null })
      yield* tracker.begin('t', 'turn-2')
      const late = yield* Effect.forkChild(Effect.flip(tracker.awaitStarted('t', 'turn-2', '10 seconds')))
      yield* TestClock.adjust('10 seconds')
      expect((yield* Fiber.join(late))._tag).toBe('ProviderTimeoutError')

      // A turn that ends (or is abandoned) while someone waits releases them.
      const ended = yield* Effect.forkChild(Effect.flip(tracker.awaitStarted('t', 'turn-2', '10 seconds')))
      yield* tracker.abandon('t', 'turn-2')
      expect((yield* Fiber.join(ended))._tag).toBe('ProviderRequestError')
      expect(tracker.current('t')).toBeNull()
    }),
  )

  it.effect('a closing session fails every open turn as a lost connection', () =>
    Effect.gen(function* () {
      const { tracker, emitted } = yield* setup
      yield* tracker.begin('a', 'turn-a')
      yield* tracker.started('b', null)
      yield* tracker.failAll('socket closed')
      const ended = emitted.filter((event) => event.type === 'turn.ended')
      expect(ended).toHaveLength(2)
      expect(ended[0]).toMatchObject({
        status: 'failed',
        failure: { class: 'transport_error', detail: 'socket closed' },
      })
      expect(tracker.current('a')).toBeNull()
    }),
  )
})
