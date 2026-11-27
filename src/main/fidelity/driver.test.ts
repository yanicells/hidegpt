import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import type { BrowserWindow } from 'electron'

import { makeDriver, type Driver } from './driver'

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

type Manifest = { failures: Array<{ step: string; error: string }> }

/** Runs `steps` on a hanging window as `runPhase` does, past the 15 s deadline; returns the exit and manifest. */
const runHanging = (dir: string, steps: (d: Driver) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const phase = Effect.gen(function* () {
      const d = yield* makeDriver(hangingWindow(), dir, 'core', {})
      yield* steps(d).pipe(Effect.ensuring(d.finish()))
    })
    const run = yield* Effect.forkChild(Effect.exit(phase))
    // Setup sleeps (viewport, reload), then the hung script's 15 s deadline.
    for (let second = 0; second < 20; second++) yield* TestClock.adjust('1 second')
    const exit = yield* Fiber.join(run)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest
    return { exit, manifest }
  })

describe('makeDriver', () => {
  it.effect('records a step whose page never answers, stops the phase and still writes the manifest', () =>
    Effect.gen(function* () {
      const { exit, manifest } = yield* runHanging(join(root, 'flat'), (d) =>
        Effect.gen(function* () {
          yield* d.step('hangs', d.js('HANG'))
          yield* d.step('never runs', Effect.void)
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(manifest.failures).toHaveLength(1)
      expect(manifest.failures[0]?.step).toBe('hangs')
      expect(manifest.failures[0]?.error).toContain('The page did not answer in time: HANG')
    }),
  )

  it.effect('records a hang once, at the innermost of nested steps', () =>
    Effect.gen(function* () {
      const { exit, manifest } = yield* runHanging(join(root, 'nested'), (d) =>
        d.step('phase', d.step('width', d.step('zoom', d.js('HANG')))),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(manifest.failures.map((failure) => failure.step)).toEqual(['zoom'])
    }),
  )
})
