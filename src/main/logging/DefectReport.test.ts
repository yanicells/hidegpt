import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Logger from 'effect/Logger'

import { BinaryMissingError, CommandRejectedError, DEFECT_MESSAGE } from '../../provider/errors'
import { describeFailure } from './DefectReport'

/** Runs `describeFailure` on the cause `effect` fails with, keeping the levels and causes it logged. */
const failWith = (effect: Effect.Effect<unknown, unknown>) =>
  Effect.gen(function* () {
    const logged: Array<{ readonly level: string; readonly cause: string }> = []
    const capture = Logger.make(({ cause, logLevel }) => void logged.push({ level: logLevel, cause: Cause.pretty(cause) }))
    const message = yield* effect.pipe(
      Effect.as('no failure'),
      Effect.catchCause(describeFailure),
      Effect.provide(Logger.layer([capture])),
    )
    return { message, logged }
  })

describe('describeFailure', () => {
  it.effect('keeps a tagged error’s sentence and logs it as a warning', () =>
    Effect.gen(function* () {
      const { message, logged } = yield* failWith(Effect.fail(new BinaryMissingError({ provider: 'codex', command: 'codex' })))
      expect(message).toMatch(/is not installed/)
      expect(logged.map((entry) => entry.level)).toEqual(['Warn'])
    }),
  )

  it.effect('does not log a request that simply could not happen', () =>
    Effect.gen(function* () {
      const { message, logged } = yield* failWith(Effect.fail(new CommandRejectedError({ reason: 'Open a document first.' })))
      expect(message).toBe('Open a document first.')
      expect(logged).toEqual([])
    }),
  )

  it.effect('hides a defect’s raw text behind a plain sentence and logs the cause', () =>
    Effect.gen(function* () {
      const { message, logged } = yield* failWith(Effect.die(new TypeError("Cannot read properties of undefined (reading 'id')")))
      expect(message).toBe(DEFECT_MESSAGE)
      expect(logged).toEqual([{ level: 'Error', cause: expect.stringContaining("reading 'id'") }])
    }),
  )

  it.effect('treats a rejected promise as a defect, not as a sentence to show', () =>
    Effect.gen(function* () {
      const { message, logged } = yield* failWith(Effect.tryPromise(() => Promise.reject(new Error('EACCES: /Users/x/images'))))
      expect(message).toBe(DEFECT_MESSAGE)
      expect(logged).toEqual([{ level: 'Error', cause: expect.stringContaining('EACCES') }])
    }),
  )
})
