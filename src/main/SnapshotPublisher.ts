import * as Cause from 'effect/Cause'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FiberHandle from 'effect/FiberHandle'
import * as Schedule from 'effect/Schedule'
import * as Stream from 'effect/Stream'

import { reportDefect } from '../provider/DefectReport'
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
/** After a defect the publisher starts over, a second apart, at most this many times. */
export const MAX_RESTARTS = 5

export interface SnapshotPublisher {
  /**
   * Runs until the snapshot stream ends (or the fiber is interrupted). A defect
   * (say, sending to the window threw) is reported and the publisher starts over:
   * it forgets what the window has and subscribes again, so the next patch holds
   * the whole current snapshot.
   */
  readonly run: Effect.Effect<void>
  /**
   * The window reloaded: sends it the whole of the newest snapshot this
   * publisher has seen. It never reads state itself, so a snapshot still on
   * its way through the stream cannot be overtaken and then revert the page.
   */
  readonly resync: () => void
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
  const once = Effect.scoped(
    Effect.gen(function* () {
      const frames = yield* FiberHandle.make<void, never>()
      yield* Stream.runForEach(snapshots, (snapshot) => {
        if (delivered !== null && delivered.streaming && snapshot.streaming && sameShape(delivered, snapshot)) {
          pending = snapshot
          return FiberHandle.run(frames, frame, { onlyIfMissing: true })
        }
        return FiberHandle.clear(frames).pipe(Effect.andThen(Effect.sync(() => deliver(snapshot))))
        // A frame runs in its own fiber; a defect there stops this run too.
      }).pipe(Effect.raceFirst(FiberHandle.join(frames)))
    }),
  )
  return {
    run: once.pipe(
      Effect.catchCauseIf(Cause.hasDies, (cause) =>
        reportDefect(cause).pipe(
          // `diffSnapshot(null, …)` is the whole snapshot, and a new subscription starts with the current one.
          Effect.andThen(
            Effect.sync(() => {
              delivered = null
              pending = null
            }),
          ),
          Effect.andThen(Effect.fail('restart' as const)),
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced('1 second'), times: MAX_RESTARTS }),
      // Out of restarts: the defects are all in the log.
      Effect.ignore,
    ),
    resync: () => {
      const latest = pending ?? delivered
      delivered = null
      if (latest) deliver(latest)
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
