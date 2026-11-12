// Adapted from T3 Code (apps/server/src/observability/DefectReporter.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Random from 'effect/Random'

import { bannerMessage, DEFECT_MESSAGE, isExpectedError } from '../../provider/errors'

/** Logs a defect's full cause under a fresh report id, and returns the id. */
export const reportDefect = (cause: Cause.Cause<unknown>): Effect.Effect<string> =>
  Effect.gen(function* () {
    const reportId = (yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16).padStart(8, '0')
    yield* Effect.logError('Unhandled defect', cause).pipe(Effect.annotateLogs({ reportId }))
    return reportId
  })

/**
 * The banner sentence for a failed effect. A tagged error keeps its own
 * sentence and is logged as a warning (unless it only says the request could
 * not happen right now); a defect, or a failure that is not a tagged error,
 * is logged in full and shows the generic sentence instead of its raw text.
 */
export const describeFailure = (cause: Cause.Cause<unknown>): Effect.Effect<string> => {
  const reason = cause.reasons.find((item) => item._tag === 'Fail' || item._tag === 'Die')
  // Interrupted with nothing else wrong: nothing to report.
  if (!reason) return Effect.succeed('Something went wrong. Try again.')
  const error = reason._tag === 'Fail' ? reason.error : undefined
  if (typeof error === 'string') return Effect.succeed(bannerMessage(error))
  if (isExpectedError(error)) {
    const log =
      error._tag === 'CommandRejectedError'
        ? Effect.void
        : Effect.logWarning(error.message).pipe(Effect.annotateLogs({ error: error._tag }))
    return Effect.as(log, bannerMessage(error))
  }
  return Effect.as(reportDefect(cause), DEFECT_MESSAGE)
}
