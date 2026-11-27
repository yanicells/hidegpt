import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'

import { ProviderRequestError } from './errors'
import { observed, undoOnFailure } from './observed'

/** Every log line's message, level and annotations. */
const captureLogs = () => {
  const lines: Array<{ level: string; message: unknown; annotations: Record<string, unknown> }> = []
  const capture = Logger.make(({ logLevel, message, fiber }) => {
    lines.push({ level: logLevel, message, annotations: fiber.getRef(References.CurrentLogAnnotations) })
  })
  return { lines, layer: Logger.layer([capture]) }
}

const refused = new ProviderRequestError({ provider: 'codex', operation: 'turn/start', detail: 'the prompt was …' })

describe('observed', () => {
  it.effect('reports a defect under its name, then runs onDefect with the report id', () => {
    const { lines, layer } = captureLogs()
    return Effect.gen(function* () {
      const seen: string[] = []
      yield* observed(Effect.die(new Error('bug')), {
        name: 'test.work',
        onDefect: (reportId) => Effect.sync(() => seen.push(reportId)),
      })
      expect(lines).toEqual([
        expect.objectContaining({
          level: 'Error',
          annotations: { where: 'test.work', reportId: seen[0] },
        }),
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect('logs a typed failure by its fields, never its sentence, unless told to stay quiet', () => {
    const { lines, layer } = captureLogs()
    return Effect.gen(function* () {
      yield* observed(Effect.fail(refused), { name: 'test.loud' })
      yield* observed(Effect.fail(refused), { name: 'test.quiet', quiet: 'nothing to do about it' })
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        level: 'Warn',
        annotations: { error: 'ProviderRequestError', operation: 'turn/start', where: 'test.loud' },
      })
      expect(JSON.stringify(lines)).not.toContain('the prompt')
    }).pipe(Effect.provide(layer))
  })

  it.effect('keeps an interrupt an interrupt', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(observed(Effect.interrupt, { name: 'test.interrupt' }))
      expect(Exit.hasInterrupts(exit)).toBe(true)
    }),
  )
})

describe('undoOnFailure', () => {
  it.effect('undoes on a typed failure and on a defect, not on success or a plain interrupt', () =>
    Effect.gen(function* () {
      let undone = 0
      const undo = undoOnFailure(() => Effect.sync(() => undone++))
      yield* Effect.exit(undo(Effect.fail(refused)))
      yield* Effect.exit(undo(Effect.die(new Error('bug'))))
      yield* undo(Effect.void)
      yield* Effect.exit(undo(Effect.interrupt))
      expect(undone).toBe(2)
    }),
  )
})
