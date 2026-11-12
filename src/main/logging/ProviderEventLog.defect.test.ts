import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'

import { make, MAX_QUEUED_LINES } from './ProviderEventLog'

/** The real file system, except that the first append dies (a bug, not an I/O error). */
const dyingOnce = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs) => {
    let first = true
    return {
      ...fs,
      writeFile: (...args: Parameters<typeof fs.writeFile>) =>
        first ? ((first = false), Effect.die(new Error('a bug in the writer'))) : fs.writeFile(...args),
    }
  }),
).pipe(Layer.provide(NodeServices.layer))

/** Every log line's message and annotations. */
const captureLogs = () => {
  const logged: Array<{ readonly message: string; readonly annotations: Record<string, unknown> }> = []
  const capture = Logger.make(({ message, fiber }) => {
    const text = Array.isArray(message) ? message.join(' ') : String(message)
    logged.push({ message: text, annotations: fiber.getRef(References.CurrentLogAnnotations) })
  })
  return { logged, layer: Logger.layer([capture]) }
}

const readLog = (path: string) =>
  Effect.sync(() => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  })

/** A temporary folder for one test, removed afterwards. */
const tempDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), 'docs-activity-defect-'))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/** A few real milliseconds, for polling the disk while the test clock stands still. */
const realPause = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))

const started = (threadId: string) => ({ type: 'turn.started', threadId, turnId: `turn-${threadId}` }) as const

describe('ProviderEventLog: defects', () => {
  /**
   * Before F-8 the writer was a bare `Effect.forever(...).pipe(Effect.forkScoped)` and each
   * write only ignored typed failures, so one Die ended the fiber for good: `record` kept
   * queueing and nothing reached the file until the app quit.
   */
  it.live('one bad batch does not end the log, and is reported once where it happened', () => {
    const { logged, layer } = captureLogs()
    return Effect.gen(function* () {
      const dir = yield* tempDir
      yield* Effect.gen(function* () {
        const log = yield* make(dir)
        yield* log.record('codex', started('first'))
        yield* Effect.sleep('400 millis')
        yield* log.record('codex', started('second'))
        yield* Effect.sleep('600 millis')
        // Read while the log is still open: closing its scope flushes the queue either way.
        expect(yield* readLog(join(dir, 'codex.ndjson'))).toContain('second')
      }).pipe(Effect.scoped)
      const reports = logged.filter((line) => line.message === 'Unhandled defect')
      expect(reports.map((line) => line.annotations.where)).toEqual(['eventLog.write'])
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, dyingOnce, layer)))
  })

  // The test clock never ends the writer's batch pause, so once it has written the first line nothing drains the queue.
  it.effect('keeps the newest lines when the writer falls behind, and says how many it dropped', () => {
    const { logged, layer } = captureLogs()
    return Effect.gen(function* () {
      const dir = yield* tempDir
      const file = join(dir, 'codex.ndjson')
      yield* Effect.gen(function* () {
        const log = yield* make(dir)
        yield* log.record('codex', started('warmup'))
        while (!(yield* readLog(file)).includes('warmup')) yield* realPause
        for (let index = 0; index < MAX_QUEUED_LINES + 5; index += 1) {
          yield* log.record('codex', started(`t${index}`))
        }
      }).pipe(Effect.scoped)
      const threads = (yield* readLog(file))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).threadId)
      expect(threads).toHaveLength(MAX_QUEUED_LINES + 1)
      expect(threads.slice(0, 2)).toEqual(['warmup', 't5'])
      expect(threads.at(-1)).toBe(`t${MAX_QUEUED_LINES + 4}`)
      const drops = logged.filter((line) => line.message === 'Event log dropped its oldest lines')
      expect(drops.map((line) => line.annotations.dropped)).toEqual([5])
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, layer)))
  })
})
