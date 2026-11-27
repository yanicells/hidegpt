import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as Fiber from 'effect/Fiber'
import type * as Scope from 'effect/Scope'

import { errorLogFields, reportDefect } from './DefectReport'
import { isExpectedError } from './errors'

/**
 * Work nobody awaits, and rollbacks that must run on any failure. In Effect a
 * Die skips `tapError`, `catch` and `ignore`, and a forked fiber that dies logs
 * nothing, so these say at the call site what happens when the work fails.
 *
 * This is the subset of the planned `observed` module that the session
 * manager needs; the rest (`forkObservedIn`, `foreverObserved`,
 * `makeRunObserved`) lands with the lint rule that bans the bare forms.
 */

export interface Observed {
  /** Names the work in the log, e.g. 'codex.elicitationCounter'. */
  readonly name: string
  /** A typed failure is logged as a warning, unless this says why it is safe to drop. */
  readonly quiet?: string
  /** Runs after a defect is reported, e.g. to raise the generic banner with the id. */
  readonly onDefect?: (reportId: string) => Effect.Effect<void>
}

/**
 * Work nobody awaits. Never fails: a defect is reported, a typed failure is
 * logged by its fields (never its sentence) or knowingly dropped. An
 * interrupt stays an interrupt.
 */
export const observed = <A, E, R>(effect: Effect.Effect<A, E, R>, options: Observed): Effect.Effect<void, never, R> =>
  Effect.catchCause(Effect.asVoid(effect), (cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
    const fail = cause.reasons.find((reason) => reason._tag === 'Fail')
    const defect = Cause.hasDies(cause) || !fail || !isExpectedError(fail.error)
    if (defect) {
      return reportDefect(cause).pipe(
        Effect.annotateLogs({ where: options.name }),
        Effect.flatMap((reportId) => options.onDefect?.(reportId) ?? Effect.void),
      )
    }
    if (options.quiet !== undefined) return Effect.void
    return Effect.logWarning('Background work failed').pipe(
      Effect.annotateLogs({ ...errorLogFields(fail.error), where: options.name }),
    )
  })

/** `Effect.forkScoped(observed(effect, options))`. */
export const forkObserved =
  (options: Observed) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Fiber.Fiber<void>, never, R | Scope.Scope> =>
    Effect.forkScoped(observed(effect, options))

/**
 * Undo optimistic state when the effect fails for any reason but a plain
 * interrupt. Use this, never `Effect.tapError`, for rollbacks: a Die skips
 * `tapError` and would leave the optimistic state behind.
 */
export const undoOnFailure =
  (undo: (cause: Cause.Cause<unknown>) => Effect.Effect<void>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.onExit(effect, (exit) =>
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? undo(exit.cause) : Effect.void,
    )
