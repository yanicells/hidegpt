import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import * as TestClock from 'effect/testing/TestClock'

import type { SnapshotPatch } from '../shared/contracts'
import { emptySnapshot, type Snapshot } from '../shared/model'
import { makeSnapshotPublisher, reportingThrows } from './SnapshotPublisher'

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 10 }))

describe('SnapshotPublisher', () => {
  it.effect('coalesces streamed deltas into one patch per frame', () =>
    Effect.gen(function* () {
      const start: Snapshot = {
        ...emptySnapshot(),
        status: 'ready',
        route: { kind: 'doc', threadId: 't' },
        streaming: true,
        blocks: [{ kind: 'agent', id: 'a', text: '' }],
      }
      const state = yield* SubscriptionRef.make(start)
      const sent: SnapshotPatch[] = []
      const publisher = makeSnapshotPublisher(SubscriptionRef.changes(state), (patch) => sent.push(patch))
      yield* Effect.forkScoped(publisher.run)
      yield* settle
      expect(sent).toHaveLength(1)

      // Deltas arrive on separate ticks, as they do from a provider.
      for (let i = 1; i <= 200; i++) {
        yield* SubscriptionRef.update(state, (s) => ({ ...s, blocks: [{ kind: 'agent' as const, id: 'a', text: 'word '.repeat(i) }] }))
        yield* Effect.yieldNow
      }
      yield* settle
      expect(sent).toHaveLength(2)
      yield* TestClock.adjust('32 millis')
      yield* settle
      // The first delta went out right away; the other 199 land together a frame later, as appended text.
      expect(sent).toHaveLength(3)
      expect(sent[2]).toMatchObject({ fields: {}, blocks: { length: 1 } })
      const appended = [sent[1], sent[2]].flatMap((patch) => patch.blocks?.append ?? []).map(([, text]) => text).join('')
      expect(appended).toBe('word '.repeat(200))

      // Text that arrives mid-frame waits; the turn's end does not, and carries that text with it.
      yield* SubscriptionRef.update(state, (s) => ({ ...s, blocks: [{ kind: 'agent' as const, id: 'a', text: 'word '.repeat(201) }] }))
      yield* settle
      expect(sent).toHaveLength(3)
      yield* SubscriptionRef.update(state, (s) => ({ ...s, streaming: false }))
      yield* settle
      expect(sent).toHaveLength(4)
      expect(sent[3]).toEqual({ fields: { streaming: false }, blocks: { length: 1, append: [[0, 'word ']] } })

      // The cancelled frame sends nothing more later.
      yield* TestClock.adjust('100 millis')
      yield* settle
      expect(sent).toHaveLength(4)
    }),
  )

  it.effect('resync sends the whole snapshot to a reloaded window', () =>
    Effect.gen(function* () {
      const snapshot = { ...emptySnapshot(), status: 'ready' as const }
      const sent: SnapshotPatch[] = []
      const publisher = makeSnapshotPublisher(SubscriptionRef.changes(yield* SubscriptionRef.make(snapshot)), (patch) => sent.push(patch))
      yield* Effect.forkScoped(publisher.run)
      yield* settle
      publisher.resync()
      expect(sent).toHaveLength(2)
      expect(Object.keys(sent[1].fields)).toContain('blocks')
    }),
  )

  it.effect('resync during a frame sends the waiting text, and the frame then sends nothing older', () =>
    Effect.gen(function* () {
      const start: Snapshot = {
        ...emptySnapshot(),
        status: 'ready',
        route: { kind: 'doc', threadId: 't' },
        streaming: true,
        blocks: [{ kind: 'agent', id: 'a', text: 'one ' }],
      }
      const state = yield* SubscriptionRef.make(start)
      const sent: Array<{ patch: SnapshotPatch; snapshot: Snapshot }> = []
      const publisher = makeSnapshotPublisher(SubscriptionRef.changes(state), (patch, snapshot) => sent.push({ patch, snapshot }))
      yield* Effect.forkScoped(publisher.run)
      yield* settle
      for (const text of ['one two ', 'one two three ']) {
        yield* SubscriptionRef.update(state, (s) => ({ ...s, blocks: [{ kind: 'agent' as const, id: 'a', text }] }))
        yield* settle
      }
      publisher.resync()
      expect(sent.at(-1)?.snapshot.blocks).toEqual([{ kind: 'agent', id: 'a', text: 'one two three ' }])
      yield* TestClock.adjust('32 millis')
      yield* settle
      expect(sent.at(-1)?.snapshot.blocks).toEqual([{ kind: 'agent', id: 'a', text: 'one two three ' }])
    }),
  )

  it.effect('starts over after a send throws, and the next snapshot arrives whole', () => {
    const logged: string[] = []
    const capture = Logger.make(({ cause, logLevel }) => {
      if (logLevel === 'Error') logged.push(Cause.pretty(cause))
    })
    return Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<Snapshot>({ ...emptySnapshot(), status: 'ready' })
      const sent: SnapshotPatch[] = []
      let broken = false
      const publisher = makeSnapshotPublisher(SubscriptionRef.changes(state), (patch) => {
        if (broken) {
          broken = false
          throw new Error('window gone')
        }
        sent.push(patch)
      })
      yield* Effect.forkScoped(publisher.run)
      yield* settle
      expect(sent).toHaveLength(1)

      broken = true
      yield* SubscriptionRef.update(state, (s) => ({ ...s, title: 'Lost' }))
      yield* settle
      expect(sent).toHaveLength(1)
      expect(logged).toEqual([expect.stringContaining('window gone')])
      expect(publisher.delivered()).toBeNull()

      // A second later it subscribes again: the current snapshot goes out whole, the lost title included.
      yield* TestClock.adjust('1 second')
      yield* settle
      expect(sent).toHaveLength(2)
      expect(sent[1]!.fields).toMatchObject({ title: 'Lost', status: 'ready', blocks: [] })
      yield* SubscriptionRef.update(state, (s) => ({ ...s, title: 'Back' }))
      yield* settle
      expect(sent[2]).toEqual({ fields: { title: 'Back' } })
    }).pipe(Effect.provide(Logger.layer([capture])))
  })

  it.effect('a send that throws mid-stream, inside a frame, starts it over too', () =>
    Effect.gen(function* () {
      const start: Snapshot = {
        ...emptySnapshot(),
        status: 'ready',
        route: { kind: 'doc', threadId: 't' },
        streaming: true,
        blocks: [{ kind: 'agent', id: 'a', text: '' }],
      }
      const state = yield* SubscriptionRef.make(start)
      const sent: Array<{ patch: SnapshotPatch; snapshot: Snapshot }> = []
      let broken = false
      const publisher = makeSnapshotPublisher(SubscriptionRef.changes(state), (patch, snapshot) => {
        if (broken) {
          broken = false
          throw new Error('window gone')
        }
        sent.push({ patch, snapshot })
      })
      yield* Effect.forkScoped(publisher.run)
      yield* settle
      broken = true
      yield* SubscriptionRef.update(state, (s) => ({ ...s, blocks: [{ kind: 'agent' as const, id: 'a', text: 'lost ' }] }))
      yield* settle
      expect(sent).toHaveLength(1)
      yield* TestClock.adjust('1 second')
      yield* settle
      expect(sent).toHaveLength(2)
      expect(sent[1]!.patch.fields).toMatchObject({ blocks: [{ kind: 'agent', id: 'a', text: 'lost ' }] })
    }).pipe(Effect.provide(Logger.layer([]))),
  )

  it.effect('restarts with backoff, starts the count over after a stable minute, and past Fatal keeps trying each minute', () => {
    const levels: string[] = []
    const reports: unknown[] = []
    const capture = Logger.make(({ fiber, logLevel }) => {
      levels.push(logLevel)
      reports.push(fiber.getRef(References.CurrentLogAnnotations).reportId)
    })
    return Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<Snapshot>({ ...emptySnapshot(), status: 'ready' })
      let failures = 0
      const sent: SnapshotPatch[] = []
      const publisher = makeSnapshotPublisher(SubscriptionRef.changes(state), (patch) => {
        if (failures > 0) {
          failures -= 1
          throw new Error('window gone')
        }
        sent.push(patch)
      })
      yield* Effect.forkScoped(publisher.run)
      yield* settle
      // One defect, then a minute of quiet: that run counts as stable.
      failures = 1
      yield* SubscriptionRef.update(state, (s) => ({ ...s, title: 'One' }))
      yield* TestClock.adjust('1 second')
      yield* settle
      expect(sent).toHaveLength(2)
      yield* TestClock.adjust('61 seconds')

      // Now every send fails. The full budget is there again: it restarts at once, then
      // after 1, 2, 4, 8 and 16 seconds, and only then gives up.
      failures = Infinity
      yield* SubscriptionRef.update(state, (s) => ({ ...s, title: 'Two' }))
      yield* settle
      yield* TestClock.adjust('30 seconds')
      yield* settle
      expect(levels.filter((level) => level === 'Fatal')).toEqual([])
      yield* TestClock.adjust('1 second')
      yield* settle
      expect(levels.filter((level) => level === 'Error')).toHaveLength(1 + 1 + 1 + 5)
      expect(levels.at(-1)).toBe('Fatal')

      const firstReport = reports.at(-2)
      expect(reports.at(-1)).toBe(firstReport)

      // It keeps trying once a minute, without another Fatal. Each try logs one Debug line
      // pointing at the last full report; the full report comes again once an hour.
      const minute = TestClock.adjust('1 minute').pipe(Effect.andThen(settle))
      yield* minute
      expect(levels.slice(-2)).toEqual(['Fatal', 'Debug'])
      expect(reports.at(-1)).toBe(firstReport)
      yield* Effect.repeat(minute, { times: 57 })
      expect(levels.filter((level) => level === 'Error')).toHaveLength(8)
      expect(levels.filter((level) => level === 'Debug')).toHaveLength(59)
      yield* minute
      expect(levels.at(-1)).toBe('Error')
      expect(reports.at(-1)).not.toBe(firstReport)
      const before = sent.length
      failures = 0
      yield* TestClock.adjust('1 minute')
      yield* settle
      expect(sent).toHaveLength(before + 1)
      expect(sent.at(-1)!.fields).toMatchObject({ title: 'Two', status: 'ready', blocks: [] })
      expect(levels.filter((level) => level === 'Fatal')).toHaveLength(1)
    }).pipe(Effect.provide(Logger.layer([capture])), Effect.provideService(References.MinimumLogLevel, 'Debug'))
  })

  it.effect('a resync whose send throws rethrows, and the next patch is whole', () =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<Snapshot>({ ...emptySnapshot(), status: 'ready' })
      let broken = false
      const sent: SnapshotPatch[] = []
      const publisher = makeSnapshotPublisher(SubscriptionRef.changes(state), (patch) => {
        if (broken) {
          broken = false
          throw new Error('window gone')
        }
        sent.push(patch)
      })
      yield* Effect.forkScoped(publisher.run)
      yield* settle
      broken = true
      expect(() => publisher.resync()).toThrow('window gone')
      expect(publisher.delivered()).toBeNull()
      yield* SubscriptionRef.update(state, (s) => ({ ...s, title: 'After' }))
      yield* settle
      expect(sent.at(-1)!.fields).toMatchObject({ title: 'After', status: 'ready', blocks: [] })
    }),
  )

  it.effect('reportingThrows reports a throw under its part, and lets it go no further', () => {
    const logged: Array<{ readonly cause: string; readonly annotations: Record<string, unknown> }> = []
    const capture = Logger.make(({ cause, fiber, logLevel }) => {
      if (logLevel === 'Error') logged.push({ cause: Cause.pretty(cause), annotations: fiber.getRef(References.CurrentLogAnnotations) })
    })
    return Effect.gen(function* () {
      const fork = Effect.runForkWith(yield* Effect.context<never>())
      let ran = false
      reportingThrows(fork, 'title', () => void (ran = true))
      expect(() =>
        reportingThrows(fork, 'menu', () => {
          throw new Error('menu bug')
        }),
      ).not.toThrow()
      yield* settle
      expect(ran).toBe(true)
      expect(logged).toEqual([
        { cause: expect.stringContaining('menu bug'), annotations: { part: 'menu', reportId: expect.stringMatching(/^[0-9a-f]{8}$/) } },
      ])
    }).pipe(Effect.provide(Logger.layer([capture])))
  })
})
