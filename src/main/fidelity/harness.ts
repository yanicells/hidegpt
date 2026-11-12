import type { BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'

import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'

import type { SnapshotDiff } from '../../shared/contracts'
import type { ProviderSessionManager } from '../ProviderSessionManager'
import { core, makeNav } from './core'
import { makeDriver, type Probes } from './driver'
import { motion } from './motion'
import { states } from './states'

const PHASES = ['core', 'states', 'motion'] as const

/**
 * The probes `targets.json` (`HIDEGPT_FIDELITY_TARGETS`) asks for: every
 * selector a metric reads, with the computed properties it compares.
 */
const readProbes = (): Probes => {
  const file = process.env.HIDEGPT_FIDELITY_TARGETS
  if (!file) return {}
  const { metrics } = JSON.parse(readFileSync(file, 'utf8')) as {
    metrics: ReadonlyArray<{ selector?: string; prop?: string; kind: string; relativeTo?: { selector: string } }>
  }
  const probes: Record<string, Set<string>> = {}
  const want = (selector: string, prop?: string) => {
    probes[selector] ??= new Set()
    if (prop) probes[selector].add(prop)
  }
  for (const metric of metrics) {
    if (metric.selector) want(metric.selector, metric.kind === 'style' ? metric.prop : undefined)
    if (metric.relativeTo) want(metric.relativeTo.selector)
  }
  return Object.fromEntries(Object.entries(probes).map(([selector, props]) => [selector, [...props]]))
}

/**
 * Runs one fidelity phase (`HIDEGPT_PHASE`) in a window that is never shown,
 * writing `<root>/<viewport>/<screen>.png|json` and `<root>/manifest.json`.
 * Loaded on demand by `captureScreenshots`, so normal runs never parse it.
 */
export const runPhase = (
  phase: string,
  win: BrowserWindow,
  manager: ProviderSessionManager['Service'],
  stage: (diff: SnapshotDiff) => void,
  root: string,
) =>
  Effect.gen(function* () {
    if (!PHASES.includes(phase as (typeof PHASES)[number])) {
      return yield* Effect.die(new Error(`Unknown HIDEGPT_PHASE "${phase}"; use ${PHASES.join(', ')}`))
    }
    yield* manager.snapshots.pipe(
      Stream.filter((snapshot) => snapshot.status !== 'connecting'),
      Stream.runHead,
    )
    win.webContents.setBackgroundThrottling(false)
    const d = yield* makeDriver(win, root, phase, readProbes())
    const nav = yield* makeNav(d, manager, stage)
    const run = phase === 'core' ? core(d, nav, manager) : phase === 'states' ? states(d, nav, manager) : motion(d, nav)
    yield* d.step(phase, run)
    yield* d.finish()
  })
