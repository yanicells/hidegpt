import type * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'

import { describeFailure } from '../provider/DefectReport'
import { neutralizeError } from './session/stealthFilter'

/**
 * The result the page gets when its request fails: `describeFailure`'s sentence
 * (a defect is logged and hidden behind a plain one), in Docs wording. Commands
 * and image saves both end in it, so a rejection on the banner or in a dialog
 * never shows a vendor name.
 */
export const failedResult = (
  cause: Cause.Cause<unknown>,
): Effect.Effect<{ readonly ok: false; readonly error: string }> =>
  Effect.map(describeFailure(cause), (error) => ({ ok: false, error: neutralizeError(error) }) as const)
