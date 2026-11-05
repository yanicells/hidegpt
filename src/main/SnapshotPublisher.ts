import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'

import type { Snapshot, SnapshotPatch } from '../shared/contracts'
import { diffSnapshot, isEmptyPatch } from '../shared/snapshot-patch'

/**
 * Sends snapshot changes to the window as patches against what it last got.
 * While an answer streams, at most one patch goes out per frame: the sliding
 * buffer keeps only the newest snapshot while the publisher waits, so a burst
 * of deltas becomes one patch carrying all of their text. Other changes
 * (navigation, a new block, the turn ending) go out as soon as the current
 * frame, if any, is over.
 */
export const STREAM_FRAME = Duration.millis(32)

export interface SnapshotPublisher {
  /** Runs until the snapshot stream ends (or the fiber is interrupted). */
  readonly run: Effect.Effect<void>
  /** The window reloaded: its next patch must carry the whole snapshot. */
  readonly resync: (snapshot: Snapshot) => void
  /** What the window last got (null before the first patch); later patches apply on top of it. */
  readonly delivered: () => Snapshot | null
}

export function makeSnapshotPublisher(
  snapshots: Stream.Stream<Snapshot>,
  send: (patch: SnapshotPatch, snapshot: Snapshot) => void,
): SnapshotPublisher {
  let delivered: Snapshot | null = null
  const deliver = (snapshot: Snapshot) => {
    const patch = diffSnapshot(delivered, snapshot)
    delivered = snapshot
    if (!isEmptyPatch(patch)) send(patch, snapshot)
  }
  return {
    run: snapshots.pipe(
      Stream.buffer({ capacity: 1, strategy: 'sliding' }),
      Stream.runForEach((snapshot) =>
        Effect.gen(function* () {
          const textOnly = delivered !== null && delivered.streaming && snapshot.streaming && sameShape(delivered, snapshot)
          deliver(snapshot)
          if (textOnly) yield* Effect.sleep(STREAM_FRAME)
        }),
      ),
    ),
    resync: (snapshot) => {
      delivered = null
      deliver(snapshot)
    },
    delivered: () => delivered,
  }
}

/** Only streamed text changed: same document, same blocks, same banner. */
const sameShape = (a: Snapshot, b: Snapshot) =>
  a.route === b.route &&
  a.blocks.length === b.blocks.length &&
  a.error === b.error &&
  a.openingThreadId === b.openingThreadId &&
  a.stopping === b.stopping
