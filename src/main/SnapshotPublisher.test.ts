import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import * as TestClock from 'effect/testing/TestClock'

import type { SnapshotPatch } from '../shared/contracts'
import { emptySnapshot, type Snapshot } from '../shared/model'
import { makeSnapshotPublisher } from './SnapshotPublisher'

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
        yield* SubscriptionRef.update(state, (s) => ({
          ...s,
          blocks: [{ kind: 'agent' as const, id: 'a', text: 'word '.repeat(i) }],
        }))
        yield* Effect.yieldNow
      }
      yield* settle
      expect(sent).toHaveLength(2)
      yield* TestClock.adjust('32 millis')
      yield* settle
      // The first delta went out right away; the other 199 land together a frame later, as appended text.
      expect(sent).toHaveLength(3)
      expect(sent[2]).toMatchObject({ fields: {}, blocks: { length: 1 } })
      const appended = [sent[1], sent[2]]
        .flatMap((patch) => patch.blocks?.append ?? [])
        .map(([, text]) => text)
        .join('')
      expect(appended).toBe('word '.repeat(200))

      // Text that arrives mid-frame waits; the turn's end does not, and carries that text with it.
      yield* SubscriptionRef.update(state, (s) => ({
        ...s,
        blocks: [{ kind: 'agent' as const, id: 'a', text: 'word '.repeat(201) }],
      }))
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
      const publisher = makeSnapshotPublisher(SubscriptionRef.changes(yield* SubscriptionRef.make(snapshot)), (patch) =>
        sent.push(patch),
      )
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
      const publisher = makeSnapshotPublisher(SubscriptionRef.changes(state), (patch, snapshot) =>
        sent.push({ patch, snapshot }),
      )
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
})
