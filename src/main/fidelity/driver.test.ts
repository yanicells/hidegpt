import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import type { BrowserWindow } from 'electron'

import { makeDriver } from './driver'

const root = mkdtempSync(join(tmpdir(), 'hidegpt-fidelity-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A window whose page answers setup, then never answers a script that says `HANG`. */
const hangingWindow = () =>
  ({
    webContents: {
      debugger: { attach: () => {}, detach: () => {}, sendCommand: async () => ({}) },
      executeJavaScript: (script: string) => (script.includes('HANG') ? new Promise(() => {}) : Promise.resolve(true)),
    },
  }) as unknown as BrowserWindow

describe('makeDriver', () => {
  it.effect('records a step whose page never answers, stops the phase and still writes the manifest', () =>
    Effect.gen(function* () {
      const phase = Effect.gen(function* () {
        const d = yield* makeDriver(hangingWindow(), root, 'core', {})
        yield* Effect.gen(function* () {
          yield* d.step('hangs', d.js('HANG'))
          yield* d.step('never runs', Effect.void)
        }).pipe(Effect.ensuring(d.finish()))
      })
      const run = yield* Effect.forkChild(Effect.exit(phase))
      // Setup sleeps (viewport, reload), then the hung script's 15 s deadline.
      for (let second = 0; second < 20; second++) yield* TestClock.adjust('1 second')
      const exit = yield* Fiber.join(run)
      expect(Exit.isFailure(exit)).toBe(true)
      const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
        failures: Array<{ step: string; error: string }>
      }
      expect(manifest.failures).toHaveLength(1)
      expect(manifest.failures[0]?.step).toBe('hangs')
      expect(manifest.failures[0]?.error).toContain('The page did not answer in time: HANG')
    }),
  )
})
