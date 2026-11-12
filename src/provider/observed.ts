import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as Fiber from 'effect/Fiber'
import * as FiberSet from 'effect/FiberSet'
import type * as Scope from 'effect/Scope'

import { errorLogFields, reportDefect } from './DefectReport'
import { isExpectedError } from './errors'

/**
 * Work nobody awaits, and rollbacks that must run on any failure. In Effect a
 * Die skips `tapError`, `catch` and `ignore`, and a forked fiber that dies logs
 * nothing, so these say at the call site what happens when the work fails.
 *
 * The lint rule `hidegpt/no-unobserved-effect` bans the bare forms (forks,
 * `Effect.run*`, `Effect.ignore`, `Effect.tapError`) everywhere else; see
 * "Background work" in docs/architecture.md.
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
    if (options.quiet !== undefined || !isExpectedError(fail.error)) return Effect.void
    return Effect.logWarning('Background work failed').pipe(
      Effect.annotateLogs({ ...errorLogFields(fail.error), where: options.name }),
    )
  })

/** `Effect.forkScoped(observed(effect, options))`. */
export const forkObserved =
  (options: Observed) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Fiber.Fiber<void>, never, R | Scope.Scope> =>
    Effect.forkScoped(observed(effect, options))

/** `Effect.forkIn(observed(effect, options), scope)`: for a scope held by a service, not the caller's. */
export const forkObservedIn =
  (scope: Scope.Scope, options: Observed) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Fiber.Fiber<void>, never, R> =>
    Effect.forkIn(observed(effect, options), scope)

/** The wait after a failed round of `foreverObserved`, doubling up to `MAX_BACKOFF_MS`. */
const FIRST_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000

/**
 * A loop that outlives a bad round. Each failed round is observed as in
 * `observed`, then the loop waits 1 s, doubling to 60 s, and goes back to 1 s
 * after a good round, so a round that always dies cannot spin. An interrupt
 * ends the loop.
 */
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
      return observed(Effect.failCause(exit.cause), options).pipe(Effect.andThen(Effect.sleep(wait)))
    })
    return Effect.forever(step)
  })

/** Starts observed work from a callback outside any fiber; see `makeRunObserved`. */
export type RunObserved<R> = <A, E>(effect: Effect.Effect<A, E, R>, options: Observed) => Fiber.Fiber<void>

/**
 * For Node and Electron callbacks, which run outside any fiber. A bare
 * `Effect.runFork` there uses Effect's default services (a console logger the
 * packaged app does not have) and outlives every scope. Fibers started through
 * this run with the services of the fiber that made it (so a warning reaches
 * the file log), are observed as in `observed`, and are interrupted when the
 * scope that made it closes. Make it before any finalizer that must wait for
 * those fibers, so that finalizer runs first.
 */
export const makeRunObserved = <R = never>(): Effect.Effect<RunObserved<R>, never, R | Scope.Scope> =>
  Effect.map(
    FiberSet.makeRuntime<R, void, never>(),
    (run): RunObserved<R> =>
      (effect, options) =>
        run(observed(effect, options)),
  )

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
