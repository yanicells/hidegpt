import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FiberHandle from 'effect/FiberHandle'
import * as Stream from 'effect/Stream'

import type { Snapshot, SnapshotPatch } from '../shared/contracts'
import { diffSnapshot, isEmptyPatch } from '../shared/snapshot-patch'

/**
 * Sends snapshot changes to the window as patches against what it last got.
 * While an answer streams, at most one patch goes out per frame: the first
 * text goes out at once, and text that arrives during the frame waits for its
 * end, so a burst of deltas becomes one patch carrying all of their text.
 * Anything else (navigation, a new block, the turn ending) goes out at once,
 * carrying the waiting text with it.
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
  /** Streamed text that arrived during the current frame. */
  let pending: Snapshot | null = null
  const deliver = (snapshot: Snapshot) => {
    pending = null
    const patch = diffSnapshot(delivered, snapshot)
    delivered = snapshot
    if (!isEmptyPatch(patch)) send(patch, snapshot)
  }
  // Sends the waiting text, then holds a frame; text that arrived meanwhile starts the next one.
  const frame: Effect.Effect<void> = Effect.suspend(() => {
    if (pending === null) return Effect.void
    deliver(pending)
    return Effect.sleep(STREAM_FRAME).pipe(Effect.andThen(frame))
  })
  return {
    run: Effect.scoped(
      Effect.gen(function* () {
        const frames = yield* FiberHandle.make<void, never>()
        yield* Stream.runForEach(snapshots, (snapshot) => {
          if (delivered !== null && delivered.streaming && snapshot.streaming && sameShape(delivered, snapshot)) {
            pending = snapshot
            return FiberHandle.run(frames, frame, { onlyIfMissing: true })
          }
          return FiberHandle.clear(frames).pipe(Effect.andThen(Effect.sync(() => deliver(snapshot))))
        })
      }),
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
