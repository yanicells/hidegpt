import { describe, expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'

import { CAPABILITIES } from '../shared/model'
import { ProviderRequestError, type ProviderError } from './errors'
import type { ThreadEvent } from './events'
import { fromLegacy, type LegacyAdapterEvent, type LegacyProviderSession } from './legacyEvents'
import type { AdapterEvent } from './ProviderAdapter'

const SETTINGS = { model: null, effort: null, serviceTier: null, mode: null }
const INPUT = { text: 'Hi', images: [], skill: null, clientId: 'local-1' }
const unused = Effect.die(new Error('not used in this test'))

/**
 * A legacy session whose events the test pushes. `send` replaces the one that accepts at
 * once; failing `backendExit` is the backend dying.
 */
const setup = (send: LegacyProviderSession['send'] = () => Effect.void) =>
  Effect.gen(function* () {
    const legacyEvents = yield* Queue.unbounded<LegacyAdapterEvent>()
    const backendExit = yield* Deferred.make<never, ProviderError>()
    const interrupts: string[] = []
    const legacy = {
      events: Stream.fromQueue(legacyEvents),
      awaitExit: Deferred.await(backendExit),
      send,
      interrupt: (threadId: string) => Effect.sync(() => void interrupts.push(threadId)),
      loadCatalog: unused,
      listDocs: () => Stream.die('unused'),
      listSkills: () => unused,
      openThread: () => unused,
      createThread: () => unused,
      loadOlder: () => unused,
      messageId: () => 'local-1',
      respond: () => unused,
      rename: () => unused,
      releaseThread: () => Effect.void,
    } satisfies LegacyProviderSession
    const session = yield* fromLegacy({
      id: 'codex',
      capabilities: CAPABILITIES.codex,
      openSession: Effect.succeed(legacy),
    }).openSession
    const seen: AdapterEvent[] = []
    yield* session.events.pipe(
      Stream.runForEach((event) => Effect.sync(() => void seen.push(event))),
      Effect.forkScoped,
    )
    const push = (...events: LegacyAdapterEvent[]) =>
      Queue.offerAll(legacyEvents, events).pipe(Effect.andThen(Effect.yieldNow.pipe(Effect.repeat({ times: 5 }))))
    const turnEvents = () =>
      seen.flatMap((event) =>
        event.type === 'turn.started' || event.type === 'turn.ended' ? [event as ThreadEvent] : [],
      )
    return { session, push, seen, turnEvents, interrupts, backendExit }
  })

const approval = {
  kind: 'approval',
  id: 'ap_1',
  suggestion: 'add',
  title: 'Run command?',
  body: 'ls',
  fields: [],
  questions: [],
  resolved: null,
} as const

describe('fromLegacy', () => {
  it.effect('gives a turn the manager’s id and exactly one terminal', () =>
    Effect.gen(function* () {
      const { session, push, turnEvents } = yield* setup()
      yield* session.send('t', 'turn-1', INPUT, SETTINGS)
      yield* push(
        { type: 'turnStarted', threadId: 't' },
        { type: 'turnEnded', threadId: 't', error: 'HTTP 429 Too Many Requests' },
        { type: 'turnEnded', threadId: 't' },
      )
      expect(turnEvents()).toEqual([
        { type: 'turn.started', threadId: 't', turnId: 'turn-1' },
        {
          type: 'turn.ended',
          threadId: 't',
          turnId: 'turn-1',
          status: 'failed',
          failure: expect.objectContaining({ class: 'usage_limit', detail: 'HTTP 429 Too Many Requests' }),
        },
      ])
    }).pipe(Effect.scoped),
  )

  it.effect('passes a failure the adapter classed itself through unchanged', () =>
    Effect.gen(function* () {
      const { session, push, turnEvents } = yield* setup()
      yield* session.send('t', 'turn-1', INPUT, SETTINGS)
      // Pattern matching the text would call this `auth`; the adapter's own class wins.
      const failure = { class: 'provider_error', detail: 'Please sign in', retryable: true, resetAt: null } as const
      yield* push({ type: 'turnEnded', threadId: 't', error: 'Please sign in', failure })
      expect(turnEvents().at(-1)).toMatchObject({ type: 'turn.ended', status: 'failed', failure })
    }).pipe(Effect.scoped),
  )

  it.effect('holds Stop pressed before the provider accepted the turn, then stops it', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { session, interrupts, turnEvents, push } = yield* setup(() => Deferred.await(gate))
      const sending = yield* Effect.forkChild(session.send('t', 'turn-1', INPUT, SETTINGS))
      yield* Effect.yieldNow
      const stopping = yield* Effect.forkChild(session.interrupt('t', 'turn-1'))
      yield* Effect.yieldNow
      expect(interrupts).toEqual([])

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(sending)
      yield* Fiber.join(stopping)
      expect(interrupts).toEqual(['t'])
      // The provider reports a normal end; the person stopped it, so it was interrupted.
      yield* push({ type: 'turnEnded', threadId: 't' })
      expect(turnEvents().at(-1)).toMatchObject({ type: 'turn.ended', status: 'interrupted', failure: null })
    }).pipe(Effect.scoped),
  )

  it.effect('a Stop that crosses the turn’s natural end succeeds without stopping anything', () =>
    Effect.gen(function* () {
      const { session, push, interrupts } = yield* setup()
      yield* session.send('t', 'turn-1', INPUT, SETTINGS)
      yield* push({ type: 'turnEnded', threadId: 't' })
      yield* session.interrupt('t', 'turn-1')
      expect(interrupts).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.effect('a turn that ends while Stop waits for its start needs no native interrupt', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { session, push, interrupts } = yield* setup(() => Deferred.await(gate))
      yield* Effect.forkChild(session.send('t', 'turn-1', INPUT, SETTINGS))
      yield* Effect.yieldNow
      const stopping = yield* Effect.forkChild(session.interrupt('t', 'turn-1'))
      yield* Effect.yieldNow
      yield* push({ type: 'turnEnded', threadId: 't' })
      yield* Fiber.join(stopping)
      expect(interrupts).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.effect('drops a late start or end from a stopped turn that the next send already closed', () =>
    Effect.gen(function* () {
      const { session, push, turnEvents } = yield* setup()
      yield* session.send('t', 'turn-1', INPUT, SETTINGS)
      yield* push({ type: 'turnStarted', threadId: 't', nativeTurnId: 'native-1' })
      yield* session.interrupt('t', 'turn-1')
      // The provider never confirmed the stop; the person sends again.
      yield* session.send('t', 'turn-2', INPUT, SETTINGS)
      yield* push(
        { type: 'turnStarted', threadId: 't', nativeTurnId: 'native-1' },
        { type: 'turnEnded', threadId: 't', nativeTurnId: 'native-1' },
      )
      expect(turnEvents().at(-1)).toEqual({ type: 'turn.started', threadId: 't', turnId: 'turn-2' })

      yield* push(
        { type: 'turnStarted', threadId: 't', nativeTurnId: 'native-2' },
        { type: 'turnEnded', threadId: 't', nativeTurnId: 'native-2' },
      )
      expect(turnEvents().at(-1)).toMatchObject({ type: 'turn.ended', turnId: 'turn-2', status: 'completed' })
    }).pipe(Effect.scoped),
  )

  it.effect('a send the provider refused leaves the thread free for the next one', () =>
    Effect.gen(function* () {
      let calls = 0
      const { session, push, turnEvents } = yield* setup(() =>
        ++calls === 1
          ? Effect.fail(new ProviderRequestError({ provider: 'codex', operation: 'send', detail: 'refused' }))
          : Effect.void,
      )
      yield* Effect.flip(session.send('t', 'turn-1', INPUT, SETTINGS))
      yield* session.send('t', 'turn-2', INPUT, SETTINGS)
      yield* push()
      expect(turnEvents()).toEqual([{ type: 'turn.started', threadId: 't', turnId: 'turn-2' }])
    }).pipe(Effect.scoped),
  )

  it.effect('a backend that dies ends the open turn as a lost connection', () =>
    Effect.gen(function* () {
      const { session, turnEvents, backendExit } = yield* setup()
      yield* session.send('t', 'turn-1', INPUT, SETTINGS)
      const exiting = yield* Effect.forkChild(Effect.flip(session.awaitExit))
      yield* Deferred.fail(
        backendExit,
        new ProviderRequestError({ provider: 'codex', operation: 'connection', detail: 'socket closed' }),
      )
      yield* Fiber.join(exiting)
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 5 }))
      expect(turnEvents().at(-1)).toMatchObject({
        type: 'turn.ended',
        turnId: 'turn-1',
        status: 'failed',
        failure: { class: 'transport_error' },
      })
    }).pipe(Effect.scoped),
  )

  it.effect('a turn’s end forgets its open approvals, so a late resolve re-sends nothing', () =>
    Effect.gen(function* () {
      const { session, push, seen } = yield* setup()
      yield* session.send('t', 'turn-1', INPUT, SETTINGS)
      yield* push(
        { type: 'block', threadId: 't', block: approval },
        { type: 'turnEnded', threadId: 't' },
        { type: 'resolved', threadId: 't', blockId: 'ap_1', resolved: 'skipped' },
      )
      expect(seen.filter((event) => event.type === 'item.upserted')).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.effect('a stale end for another turn keeps the open turn’s approvals', () =>
    Effect.gen(function* () {
      const { session, push, seen } = yield* setup()
      yield* session.send('t', 'turn-1', INPUT, SETTINGS)
      yield* push(
        { type: 'turnStarted', threadId: 't', nativeTurnId: 'native-1' },
        { type: 'block', threadId: 't', block: approval },
        { type: 'turnEnded', threadId: 't', nativeTurnId: 'native-0' },
        { type: 'resolved', threadId: 't', blockId: 'ap_1', resolved: 'accepted' },
      )
      expect(seen.flatMap((event) => (event.type === 'item.upserted' ? [event.item] : [])).at(-1)).toMatchObject({
        id: 'ap_1',
        status: 'accepted',
      })
    }).pipe(Effect.scoped),
  )

  it.effect('re-sends a resolved approval whole, as expired when the provider settled it', () =>
    Effect.gen(function* () {
      const { push, seen } = yield* setup()
      yield* push(
        { type: 'block', threadId: 't', block: approval },
        { type: 'resolved', threadId: 't', blockId: 'ap_1', resolved: 'skipped' },
      )
      const items = seen.flatMap((event) => (event.type === 'item.upserted' ? [event.item] : []))
      expect(items).toEqual([
        expect.objectContaining({ kind: 'request', id: 'ap_1', request: 'tool_access', status: 'pending' }),
        expect.objectContaining({ kind: 'request', id: 'ap_1', detail: 'ls', status: 'expired' }),
      ])
    }).pipe(Effect.scoped),
  )

  it.effect('passes a defect in the legacy stream to the consumer instead of losing it', () =>
    Effect.gen(function* () {
      const legacy = {
        events: Stream.die(new Error('mapping bug')),
        awaitExit: Effect.never,
      } as unknown as LegacyProviderSession
      const session = yield* fromLegacy({
        id: 'codex',
        capabilities: CAPABILITIES.codex,
        openSession: Effect.succeed(legacy),
      }).openSession
      const exit = yield* Effect.exit(Stream.runDrain(session.events))
      expect(Exit.hasDies(exit)).toBe(true)
    }).pipe(Effect.scoped),
  )
})
