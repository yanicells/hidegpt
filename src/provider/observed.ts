import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import { errorLogFields, reportDefect } from './DefectReport'
import { isExpectedError } from './errors'

/**
 * Work nobody awaits must still say what happens when it fails: a forked
 * fiber nobody joins loses its Die silently, and `Effect.ignore` lets a Die
 * through. These helpers report a defect, log or knowingly drop a typed
 * failure, and keep an interrupt an interrupt.
 */

export interface Observed {
  /** Names the work in the log, e.g. 'codex.elicitationCounter'. */
  readonly name: string
  /** A typed failure is logged as a warning, unless this says why it is safe to drop. */
  readonly quiet?: string
  /** Runs after a defect is reported, e.g. to raise the generic banner with the id. */
  readonly onDefect?: (reportId: string) => Effect.Effect<void>
}

const handle = (cause: Cause.Cause<unknown>, options: Observed): Effect.Effect<void> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
  const defect = cause.reasons.some(
    (reason) => reason._tag === 'Die' || (reason._tag === 'Fail' && !isExpectedError(reason.error)),
  )
  if (defect) {
    return reportDefect(cause).pipe(
      Effect.annotateLogs({ where: options.name }),
      Effect.flatMap((reportId) => options.onDefect?.(reportId) ?? Effect.void),
    )
  }
  // No defect, so every failure here is one of Docs' tagged errors.
  const error = cause.reasons.flatMap((reason) => (reason._tag === 'Fail' ? [reason.error] : []))[0]
  if (!isExpectedError(error) || options.quiet !== undefined) return Effect.void
  // Never the error's sentence: a provider's text can echo what was sent.
  return Effect.logWarning('Background work failed').pipe(
    Effect.annotateLogs({ ...errorLogFields(error), where: options.name }),
  )
}

/** Work nobody awaits. Never fails: a defect is reported, a typed failure is logged or
 *  knowingly dropped. An interrupt stays an interrupt. */
export const observed = <A, E, R>(effect: Effect.Effect<A, E, R>, options: Observed): Effect.Effect<void, never, R> =>
  Effect.catchCause(Effect.asVoid(effect), (cause) => handle(cause, options))

const FIRST_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000

/** A loop that outlives a bad round. After a failed round it waits 1 s, doubling to 60 s,
 *  and goes back to 1 s after a good round, so a round that always dies cannot spin. */
export const foreverObserved = <A, E, R>(
  round: Effect.Effect<A, E, R>,
  options: Observed,
): Effect.Effect<never, never, R> =>
  Effect.suspend(() => {
    let backoff = FIRST_BACKOFF_MS
    const step = Effect.flatMap(Effect.exit(round), (exit) => {
      if (Exit.isSuccess(exit)) {
        backoff = FIRST_BACKOFF_MS
        return Effect.void
      }
      const wait = backoff
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      return handle(exit.cause, options).pipe(Effect.andThen(Effect.sleep(wait)))
    })
    return Effect.forever(step)
  })
