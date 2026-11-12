import * as Effect from 'effect/Effect'

import type { ProviderId } from '../shared/model'
import { newReportId } from './DefectReport'

/**
 * Why a turn failed, as a class Docs words itself. The provider's own text
 * (`detail`) can name the vendor, carry URLs, or echo what was sent, so it goes
 * to the log only. Classes follow ARCH-1's `turn.ended.failure`.
 */
export type TurnFailureKind =
  | 'usage_limit'
  | 'auth'
  | 'provider_error'
  | 'validation_error'
  | 'transport_error'
  | 'unknown'

export type TurnFailure = { readonly kind: TurnFailureKind; readonly detail: string }

/** The sentence a failure shows behind "Details" (wording: STL-2, "Failures"). */
export const FAILURE_SENTENCES: Record<TurnFailureKind, string> = {
  usage_limit: "You've reached this account's limit. Try again later.",
  auth: 'This account signs in outside Docs. Sign in, then use Tools → Refresh.',
  provider_error: "Docs couldn't finish. Try again.",
  validation_error: "Docs couldn't finish. Try again.",
  transport_error: 'Docs lost its connection. Try again.',
  unknown: "Docs couldn't finish. Try again.",
}

/**
 * Logs a failed turn's raw detail under a fresh report id, and returns what the
 * turn's error shows: the class's sentence plus that id, so the log line can be
 * found from the screen.
 */
export const reportTurnFailure = (provider: ProviderId, failure: TurnFailure): Effect.Effect<string> =>
  Effect.gen(function* () {
    const reportId = yield* newReportId
    yield* Effect.logWarning('Turn failed').pipe(
      Effect.annotateLogs({ provider, reportId, failure: failure.kind, detail: failure.detail }),
    )
    return `${FAILURE_SENTENCES[failure.kind]} (Report ${reportId})`
  })
