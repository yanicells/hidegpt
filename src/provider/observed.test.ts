import { describe, expect, it } from '@effect/vitest'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'
import * as TestClock from 'effect/testing/TestClock'

import { ProviderRequestError } from './errors'
import { forkObserved, forkObservedIn, foreverObserved, makeRunObserved, observed, undoOnFailure } from './observed'
import { captureReports } from './observed.testkit'

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

describe('observed, beyond tagged errors', () => {
  it.effect('reports a failure that is not a tagged error as a defect, even when told to stay quiet', () => {
    const { layer, reported } = captureReports()
    return Effect.gen(function* () {
      yield* observed(Effect.fail({ rejected: true }), { name: 'test.untagged', quiet: 'only tagged errors' })
      expect(reported()).toEqual([expect.objectContaining({ where: 'test.untagged' })])
    }).pipe(Effect.provide(layer))
  })

  it.effect('reports a defect once when its failure also travels on and is reported again', () => {
    const { layer, reported } = captureReports()
    return Effect.gen(function* () {
      const bug = new Error('bug')
      yield* observed(Effect.die(bug), { name: 'test.first' })
      yield* observed(Effect.die(bug), { name: 'test.again' })
      expect(reported().map((report) => report.where)).toEqual(['test.first'])
    }).pipe(Effect.provide(layer))
  })
})

describe('forkObserved and forkObservedIn', () => {
  it.effect('report a forked fiber that dies, which a bare fork leaves silent', () => {
    const { layer, reported } = captureReports()
    return Effect.gen(function* () {
      yield* Fiber.await(yield* Effect.forkChild(Effect.die(new Error('lost'))))
      expect(reported()).toEqual([])
      const scope = yield* Effect.scope
      yield* Fiber.await(yield* forkObserved({ name: 'test.scoped' })(Effect.die(new Error('a'))))
      yield* Fiber.await(yield* forkObservedIn(scope, { name: 'test.in' })(Effect.die(new Error('b'))))
      expect(reported().map((report) => report.where)).toEqual(['test.scoped', 'test.in'])
    }).pipe(Effect.scoped, Effect.provide(layer))
  })
})

describe('foreverObserved', () => {
  it.effect('outlives a dying round, backs off from 1 s doubling, and starts over after a good round', () => {
    const { layer, reported } = captureReports()
    return Effect.gen(function* () {
      // Three rounds die, one succeeds, one dies, then the last never ends.
      const plan = ['die', 'die', 'die', 'ok', 'die'] as const
      const starts: number[] = []
      const round = Effect.gen(function* () {
        starts.push(yield* Clock.currentTimeMillis)
        const step = plan[starts.length - 1]
        if (step === 'die') return yield* Effect.die(new Error(`round ${starts.length}`))
        if (step === undefined) return yield* Effect.never
      })
      const loop = yield* Effect.forkChild(foreverObserved(round, { name: 'test.loop' }))
      yield* TestClock.adjust('1 minute')
      expect(starts).toEqual([0, 1_000, 3_000, 7_000, 7_000, 8_000])
      expect(reported().map((report) => report.where)).toEqual(Array(4).fill('test.loop'))
      yield* Fiber.interrupt(loop)
    }).pipe(Effect.provide(layer))
  })

  it.effect('waits at most 60 s between failed rounds', () =>
    Effect.gen(function* () {
      const starts: number[] = []
      const round = Effect.flatMap(Clock.currentTimeMillis, (now) => {
        starts.push(now)
        return Effect.fail(new ProviderRequestError({ provider: 'codex', operation: 'poll', detail: '' }))
      })
      const loop = yield* Effect.forkChild(foreverObserved(round, { name: 'test.capped', quiet: 'test' }))
      yield* TestClock.adjust('10 minutes')
      const gaps = starts.slice(1).map((start, index) => start - starts[index]!)
      expect(gaps.slice(0, 7)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000])
      expect(Math.max(...gaps)).toBe(60_000)
      yield* Fiber.interrupt(loop)
    }),
  )
})

describe('makeRunObserved', () => {
  it.effect('runs work from a plain callback with the logger it was made with, and stops it with its scope', () => {
    const { layer, reported } = captureReports()
    return Effect.gen(function* () {
      let stopped = false
      yield* Effect.scoped(
        Effect.gen(function* () {
          const run = yield* makeRunObserved()
          // A Node timer callback, outside any fiber.
          const fromCallback = yield* Effect.callback<Fiber.Fiber<void>>((resume) => {
            setTimeout(() => resume(Effect.succeed(run(Effect.die(new Error('bug')), { name: 'test.callback' }))), 0)
          })
          yield* Fiber.await(fromCallback)
          run(Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (stopped = true)))), {
            name: 'test.long',
          })
          yield* Effect.yieldNow
        }),
      )
      expect(reported()).toEqual([expect.objectContaining({ where: 'test.callback' })])
      expect(stopped).toBe(true)
    }).pipe(Effect.provide(layer))
  })
})
