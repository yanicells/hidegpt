import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
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
/**
 * After a defect the publisher starts over: 1 s, doubling, five times (31 s in all). A run
 * that lasted a minute starts the count over, as the session manager's restarts do.
 */
const RESTART_SCHEDULE = Schedule.exponential('1 second').pipe(Schedule.upTo({ times: 5 }))
const STABLE_AFTER = Duration.seconds(60)

export interface SnapshotPublisher {
  /**
   * Runs until the snapshot stream ends (or the fiber is interrupted). A defect
   * (say, sending to the window threw) is reported and the publisher starts over:
   * it forgets what the window has and subscribes again, so the next patch holds
   * the whole current snapshot. Out of restarts, it logs at Fatal and stops.
   */
  readonly run: Effect.Effect<void>
  /**
   * The window reloaded: sends it the whole of the newest snapshot this
   * publisher has seen. It never reads state itself, so a snapshot still on
   * its way through the stream cannot be overtaken and then revert the page.
   * If sending throws, it forgets what the window has (so the next patch is
   * whole) and rethrows for the caller to report.
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
  // `diffSnapshot(null, …)` is the whole snapshot, and a new subscription starts with the current one.
  const forget = () => {
    delivered = null
    pending = null
  }
  /** One run. Ends with `true` when it should start over at once: a defect after a stable run. */
  const attempt = Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    return yield* once.pipe(
      Effect.as(false),
      Effect.catchCauseIf(Cause.hasDies, (cause) =>
        reportDefect(cause).pipe(
          Effect.andThen(Effect.sync(forget)),
          Effect.andThen(Clock.currentTimeMillis),
          Effect.flatMap((at) =>
            at - startedAt >= Duration.toMillis(STABLE_AFTER) ? Effect.succeed(true) : Effect.fail('restart' as const),
          ),
        ),
      ),
    )
  })
  return {
    run: attempt.pipe(
      Effect.retry(RESTART_SCHEDULE),
      Effect.repeat({ while: (again) => again }),
      Effect.catch(() => Effect.logFatal('The window stopped getting updates after repeated defects')),
      Effect.asVoid,
    ),
    resync: () => {
      const latest = pending ?? delivered
      delivered = null
      if (!latest) return
      try {
        deliver(latest)
      } catch (error) {
        forget()
        throw error
      }
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
