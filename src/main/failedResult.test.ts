import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Logger from 'effect/Logger'

import { CommandRejectedError, DEFECT_MESSAGE } from '../provider/errors'
import { failedResult } from './failedResult'

/** What the page gets back when `effect` fails, with logging muted. */
const resultOf = <E>(effect: Effect.Effect<unknown, E>) =>
  effect.pipe(Effect.as({ ok: true } as const), Effect.catchCause(failedResult), Effect.provide(Logger.layer([])))

describe('failedResult', () => {
  it.effect('puts a rejection into Docs wording', () =>
    Effect.gen(function* () {
      const rejected = new CommandRejectedError({ reason: 'Claude is still answering.' })
      expect(yield* resultOf(Effect.fail(rejected))).toEqual({ ok: false, error: 'Docs is still answering.' })
    }),
  )

  it.effect('hides a failed image save, as app.ts runs it, behind the defect sentence', () =>
    Effect.gen(function* () {
      const save = Effect.promise(() => Promise.reject(new Error('EACCES: ~/.claude/images/paste.png')))
      expect(yield* resultOf(save)).toEqual({ ok: false, error: DEFECT_MESSAGE })
    }),
  )
})
