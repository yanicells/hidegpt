import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'

import { describeFailure, errorLogFields, logDefects, reportDefect } from './DefectReport'
import { CommandRejectedError, DEFECT_MESSAGE, ProcessExitedError, ProviderRequestError } from './errors'

type Logged = { readonly level: string; readonly text: string }

/** Runs `effect` with a logger that keeps each line's level and everything it wrote (message, cause, annotations). */
const capturing = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const logged: Logged[] = []
    const capture = Logger.make(({ cause, fiber, logLevel, message }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations)
      logged.push({ level: logLevel, text: `${JSON.stringify({ message, annotations })} ${Cause.pretty(cause)}` })
    })
    const result = yield* Effect.exit(effect.pipe(Effect.provide(Logger.layer([capture]))))
    return { result, logged }
  })

/** The banner sentence for the cause `effect` fails with, and what was logged. */
const failWith = <E>(effect: Effect.Effect<unknown, E>) =>
  capturing(effect.pipe(Effect.as('no failure'), Effect.catchCause(describeFailure))).pipe(
    Effect.map(({ result, logged }) => ({ message: result._tag === 'Success' ? result.value : 'failed', logged })),
  )

describe('describeFailure', () => {
  it.effect('keeps a tagged error’s sentence for the banner, but logs only its tag and operation', () =>
    Effect.gen(function* () {
      const error = new ProviderRequestError({
        provider: 'codex',
        operation: 'turn/start',
        detail: 'invalid input: Prompt-81aa',
      })
      const { message, logged } = yield* failWith(Effect.fail(error))
      expect(message).toBe('invalid input: Prompt-81aa')
      expect(logged).toEqual([{ level: 'Warn', text: expect.stringContaining('"operation":"turn/start"') }])
      expect(logged[0]!.text).toContain('ProviderRequestError')
      expect(logged[0]!.text).not.toContain('Prompt-81aa')
    }),
  )

  it.effect('does not log a request that simply could not happen', () =>
    Effect.gen(function* () {
      const { message, logged } = yield* failWith(
        Effect.fail(new CommandRejectedError({ reason: 'Open a document first.' })),
      )
      expect(message).toBe('Open a document first.')
      expect(logged).toEqual([])
    }),
  )

  it.effect('hides a defect’s raw text behind a plain sentence and logs the cause', () =>
    Effect.gen(function* () {
      const { message, logged } = yield* failWith(
        Effect.die(new TypeError("Cannot read properties of undefined (reading 'id')")),
      )
      expect(message).toBe(DEFECT_MESSAGE)
      expect(logged).toEqual([{ level: 'Error', text: expect.stringContaining("reading 'id'") }])
    }),
  )

  it.effect('reports a defect that arrives beside a tagged error, instead of showing only the tagged one', () =>
    Effect.gen(function* () {
      const tagged = new ProviderRequestError({ provider: 'codex', operation: 'turn/start', detail: 'Prompt-81aa' })
      const { message, logged } = yield* failWith(
        Effect.failCause(Cause.combine(Cause.fail(tagged), Cause.die(new Error('bad frame')))),
      )
      expect(message).toBe(DEFECT_MESSAGE)
      expect(logged).toEqual([{ level: 'Error', text: expect.stringContaining('bad frame') }])
      expect(logged[0]!.text).not.toContain('Prompt-81aa')
    }),
  )

  it.effect('treats a rejected promise as a defect, not as a sentence to show', () =>
    Effect.gen(function* () {
      const { message, logged } = yield* failWith(
        Effect.promise(() => Promise.reject(new Error('EACCES: /Users/x/images'))),
      )
      expect(message).toBe(DEFECT_MESSAGE)
      expect(logged).toEqual([{ level: 'Error', text: expect.stringContaining('EACCES') }])
    }),
  )
})

describe('reportDefect', () => {
  it.effect('logs only the defect parts of a cause, as T3 Code’s DefectReporter does', () =>
    Effect.gen(function* () {
      const tagged = new ProviderRequestError({ provider: 'codex', operation: 'turn/start', detail: 'Prompt-81aa' })
      const cause = Cause.combine(Cause.fail(tagged), Cause.die(new Error('bad frame')))
      const { result, logged } = yield* capturing(reportDefect(cause))
      expect(result._tag === 'Success' && result.value).toMatch(/^[0-9a-f]{8}$/)
      expect(logged).toEqual([{ level: 'Error', text: expect.stringContaining('bad frame') }])
      expect(logged[0]!.text).not.toContain('Prompt-81aa')
    }),
  )
})

describe('logDefects', () => {
  it.effect('logs a defect in work nobody awaits, and keeps it', () =>
    Effect.gen(function* () {
      const { result, logged } = yield* capturing(logDefects(Effect.die(new Error('refresh bug'))))
      expect(result._tag).toBe('Failure')
      expect(logged).toEqual([{ level: 'Error', text: expect.stringContaining('refresh bug') }])
    }),
  )

  it.effect('logs every defect in the cause, not only the first', () =>
    Effect.gen(function* () {
      const cause = Cause.combine(Cause.die(new Error('first bug')), Cause.die(new Error('second bug')))
      const { logged } = yield* capturing(logDefects(Effect.failCause(cause)))
      expect(logged).toEqual([{ level: 'Error', text: expect.stringContaining('first bug') }])
      expect(logged[0]!.text).toContain('second bug')
    }),
  )
})

describe('errorLogFields', () => {
  it('says whether a stopped process explained itself, and how much, never what it printed', () => {
    const exited = new ProcessExitedError({
      provider: 'codex',
      code: 1,
      signal: null,
      stderr: 'panic near Prompt-81aa',
    })
    const fields = errorLogFields(exited)
    expect(fields).toEqual({
      error: 'ProcessExitedError',
      provider: 'codex',
      code: 1,
      signal: null,
      hasStderr: true,
      stderrLength: 'panic near Prompt-81aa'.length,
    })
    expect(JSON.stringify(fields)).not.toContain('Prompt-81aa')
    expect(errorLogFields(new ProcessExitedError({ provider: 'codex', code: null, signal: 'SIGKILL' }))).toMatchObject({
      hasStderr: false,
      stderrLength: 0,
    })
  })
})
