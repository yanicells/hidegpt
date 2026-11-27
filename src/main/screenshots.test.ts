import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import type { BrowserWindow } from 'electron'

import { emptySnapshot } from '../shared/model'
import type { ProviderSessionManager } from './ProviderSessionManager'
import { captureScreenshots } from './screenshots'

const dir = mkdtempSync(join(tmpdir(), 'docs-shots-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A window whose page never answers; every other call does nothing. */
const hungWindow = () => {
  const webContents = new Proxy(
    { executeJavaScript: () => new Promise(() => {}) },
    {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
    },
  )
  return new Proxy(
    { webContents },
    {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
    },
  ) as unknown as BrowserWindow
}

const manager = {
  snapshots: Stream.make({ ...emptySnapshot('/docs'), status: 'ready' as const }),
} as unknown as ProviderSessionManager['Service']

describe('captureScreenshots', () => {
  it.effect('fails the step when the page never answers, so the run can still quit', () =>
    Effect.gen(function* () {
      const walk = yield* Effect.forkChild(Effect.exit(captureScreenshots(hungWindow(), manager, () => {}, dir)))
      yield* TestClock.adjust('16 seconds')
      const exit = yield* Fiber.join(walk)
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain('The page did not answer in time')
    }),
  )
})
