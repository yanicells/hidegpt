import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import { onTestFinished, vi } from 'vitest'

import { ProviderEventLog, layer } from './ProviderEventLog'
import type { RotatingFileSink } from './rotatingFileSink'

// Writing any line about thread `bad` is a Docs bug.
vi.mock('./rotatingFileSink', async (importOriginal) => {
  const real = await importOriginal<typeof import('./rotatingFileSink')>()
  const Effect = await import('effect/Effect')
  return {
    ...real,
    makeRotatingFileSink: (options: Parameters<typeof real.makeRotatingFileSink>[0]) =>
      real.makeRotatingFileSink(options).pipe(
        Effect.map((sink): RotatingFileSink => ({
          ...sink,
          write: (text) => (text.includes('"threadId":"bad"') ? Effect.die(new Error('sink bug')) : sink.write(text)),
        })),
      ),
  }
})

describe('ProviderEventLog writer', () => {
  // Real time: the writer works in batches half a second apart.
  it.live('keeps writing after a write dies, and reports it', () => {
    const logged: string[] = []
    const capture = Logger.make(({ cause, logLevel }) => {
      if (logLevel === 'Error') logged.push(Cause.pretty(cause))
    })
    return Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), 'docs-provider-log-'))
      onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
      yield* Effect.gen(function* () {
        const log = yield* ProviderEventLog
        yield* log.record('codex', { type: 'turnStarted', threadId: 'bad' })
        yield* Effect.sleep('700 millis')
        yield* log.record('codex', { type: 'turnStarted', threadId: 'good' })
        yield* Effect.sleep('700 millis')
        // Read before the scope closes: its last flush would write the line even with the writer gone.
        expect(readFileSync(join(dir, 'codex.ndjson'), 'utf8')).toContain('"threadId":"good"')
      }).pipe(Effect.provide(layer(dir)))
      expect(logged).toEqual([expect.stringContaining('sink bug')])
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([capture]))))
  })
})
