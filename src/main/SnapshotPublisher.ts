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
 * that lasted a minute starts the count over, as the session manager's restarts do. Past
 * that it logs at Fatal once and keeps trying every minute, so the page can come back.
 * Those tries log one short Debug line each, and a full report once an hour, so a
 * stuck window does not rotate the Fatal and the first report out of the log.
 */
const RESTART_SCHEDULE = Schedule.exponential('1 second').pipe(Schedule.upTo({ times: 5 }))
const SLOW_RETRY = Duration.minutes(1)
const FULL_REPORT_EVERY = 60
const STABLE_AFTER = Duration.seconds(60)

export interface SnapshotPublisher {
  /**
   * Runs until the snapshot stream ends (or the fiber is interrupted). A defect
   * (say, sending to the window threw) is reported and the publisher starts over:
   * it forgets what the window has and subscribes again, so the next patch holds
   * the whole current snapshot. Out of quick restarts, it logs at Fatal and then
   * tries once a minute.
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
  /** The id of the last defect logged in full; the quiet retries point back at it. */
  let lastReport = ''
  const report = (cause: Cause.Cause<unknown>) =>
    reportDefect(cause).pipe(Effect.tap((id) => Effect.sync(() => void (lastReport = id))))
  let slowTries = 0
  const reportQuietly = (cause: Cause.Cause<unknown>) => {
    slowTries += 1
    return slowTries % FULL_REPORT_EVERY === 0
      ? report(cause)
      : Effect.logDebug('The window still is not getting updates').pipe(
          Effect.annotateLogs({ reportId: lastReport, tries: slowTries }),
        )
  }
  /** One run. Ends with `true` when it should start over at once: a defect after a stable run. */
  const attempt = (onDefect: (cause: Cause.Cause<unknown>) => Effect.Effect<unknown>) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      return yield* once.pipe(
        Effect.as(false),
        Effect.catchCauseIf(Cause.hasDies, (cause) =>
          onDefect(cause).pipe(
            Effect.andThen(Effect.sync(forget)),
            Effect.andThen(Clock.currentTimeMillis),
            Effect.flatMap((at) =>
              at - startedAt >= Duration.toMillis(STABLE_AFTER) ? Effect.succeed(true) : Effect.fail('restart' as const),
            ),
          ),
        ),
      )
    })
  const restarting = attempt(report).pipe(
    Effect.retry(RESTART_SCHEDULE),
    Effect.catch(() =>
      Effect.logFatal('The window stopped getting updates after repeated defects').pipe(
        Effect.annotateLogs({ reportId: lastReport }),
        Effect.andThen(Effect.sync(() => void (slowTries = 0))),
        // Then once a minute, for good, so a reload or a reopened window can recover.
        // It retries forever, so `orDie` never fires; it only drops the error type.
        Effect.andThen(Effect.sleep(SLOW_RETRY)),
        Effect.andThen(attempt(reportQuietly).pipe(Effect.retry(Schedule.spaced(SLOW_RETRY)), Effect.orDie)),
      ),
    ),
  )
  return {
    run: restarting.pipe(
      Effect.repeat({ while: (again) => again }),
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

/**
 * Runs `run`, which is called outside any fiber (from `send`, or an Electron
 * event): a throw is reported under `part`, through `fork`, and goes no further.
 * Used for the extras around a patch (the title, the menu) and for `resync`.
 */
export function reportingThrows(fork: (report: Effect.Effect<string>) => void, part: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    fork(reportDefect(Cause.die(error)).pipe(Effect.annotateLogs({ part })))
  }
}

/** Only streamed text changed: same document, same blocks, same banner. */
const sameShape = (a: Snapshot, b: Snapshot) =>
  a.route === b.route &&
  a.blocks.length === b.blocks.length &&
  a.error === b.error &&
  a.openingThreadId === b.openingThreadId &&
  a.stopping === b.stopping
