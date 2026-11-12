// Adapted from T3 Code (apps/server/src/observability/DefectReporter.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Random from 'effect/Random'

import { bannerMessage, type CommandRejectedError, DEFECT_MESSAGE, isExpectedError, type ProviderError } from './errors'

/**
 * Logs the defect parts of a cause under a fresh report id, and returns the
 * id. Like T3 Code's `DefectReporter`, only defects are logged: a die, or a
 * failure that is not one of Docs' tagged errors (a rejected promise).
 * Tagged errors and interruptions in the same cause are left out.
 */
export const reportDefect = (cause: Cause.Cause<unknown>): Effect.Effect<string> =>
  Effect.gen(function* () {
    const reportId = (yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16).padStart(8, '0')
    const defects = cause.reasons.filter(
      (reason) => reason._tag === 'Die' || (reason._tag === 'Fail' && !isExpectedError(reason.error)),
    )
    if (defects.length > 0) {
      yield* Effect.logError('Unhandled defect', Cause.fromReasons(defects)).pipe(Effect.annotateLogs({ reportId }))
    }
    return reportId
  })

/** Logs a defect in `effect` (work nobody awaits, which would otherwise die silently) and keeps it. */
export const logDefects = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.tapDefect(effect, (defect) => reportDefect(Cause.die(defect)))

/**
 * What a tagged error may put in the log: its tag and structural fields.
 * Never its sentence: a provider's error text can echo what was sent (a
 * rejected `turn/start` quoting the prompt), and a process can print anything
 * to stderr. The sentence still reaches the banner.
 */
export function errorLogFields(error: ProviderError | CommandRejectedError): Record<string, unknown> {
  switch (error._tag) {
    case 'ProviderTimeoutError':
      return { error: error._tag, provider: error.provider, operation: error.operation, seconds: error.seconds }
    case 'ProcessExitedError':
      // Whether the process said why, and how much: enough to tell a silent crash from a
      // complaint, without its words.
      return {
        error: error._tag,
        provider: error.provider,
        code: error.code,
        signal: error.signal,
        hasStderr: Boolean(error.stderr),
        stderrLength: error.stderr?.length ?? 0,
      }
    case 'BinaryMissingError':
      return { error: error._tag, provider: error.provider, command: error.command }
    case 'ProviderRequestError':
      return { error: error._tag, provider: error.provider, operation: error.operation }
    case 'ProviderDefectError':
      return { error: error._tag, provider: error.provider, reportId: error.reportId }
    case 'NotLoggedInError':
    case 'ProviderNotReadyError':
      return { error: error._tag, provider: error.provider }
    case 'CommandRejectedError':
      return { error: error._tag }
  }
}

/**
 * The banner sentence for a failed effect. A tagged error keeps its own
 * sentence and is logged as a warning by its fields (unless it only says the
 * request could not happen right now); a defect, or a failure that is not a
 * tagged error, is logged in full and shows the generic sentence instead of
 * its raw text. A defect anywhere in the cause wins, even beside a tagged error.
 */
export const describeFailure = (cause: Cause.Cause<unknown>): Effect.Effect<string> => {
  if (cause.reasons.some((item) => item._tag === 'Die')) return Effect.as(reportDefect(cause), DEFECT_MESSAGE)
  const reason = cause.reasons.find((item) => item._tag === 'Fail')
  // Interrupted with nothing else wrong: nothing to report.
  if (!reason) return Effect.succeed('Something went wrong. Try again.')
  const error = reason.error
  if (typeof error === 'string') return Effect.succeed(bannerMessage(error))
  if (isExpectedError(error)) {
    const log =
      error._tag === 'CommandRejectedError'
        ? Effect.void
        : Effect.logWarning('Request failed').pipe(Effect.annotateLogs(errorLogFields(error)))
    return Effect.as(log, bannerMessage(error))
  }
  return Effect.as(reportDefect(cause), DEFECT_MESSAGE)
}
