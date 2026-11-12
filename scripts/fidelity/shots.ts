import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/**
 * `pnpm fidelity:shots [--phase core,states,motion] [--out dir] [--no-build]`:
 * builds the app and runs each fidelity phase (src/main/fidelity) in its own
 * hidden Electron, all at once, with the fake providers. No window is shown and
 * no Dock icon appears; on macOS `open -g -n -W` also keeps the app from
 * activating. Screens land in `<out>/<phase>/<viewport>/<screen>.png|json`.
 */

const PHASES = ['core', 'states', 'motion']
const { values } = parseArgs({
  options: {
    phase: { type: 'string', default: 'core,states' },
    out: { type: 'string', default: 'screenshots/fidelity' },
    'no-build': { type: 'boolean', default: false },
  },
})
const phases = values.phase.split(',').filter(Boolean)
const unknown = phases.filter((phase) => !PHASES.includes(phase))
if (unknown.length > 0) throw new Error(`Unknown phase ${unknown.join(', ')}; use ${PHASES.join(', ')}`)

const repo = resolve(import.meta.dirname, '../..')
const out = resolve(repo, values.out)
const targets = join(repo, 'scripts/fidelity/targets.json')
// The `electron` package exports the path of its binary.
const electron = createRequire(import.meta.url)('electron') as unknown as string

type Manifest = { shots: unknown[]; failures: Array<{ step: string; error: string }> }

/** Runs one phase to completion; resolves with its manifest, or null when it never wrote one. */
const runPhase = (phase: string): Promise<Manifest | null> => {
  const dir = join(out, phase)
  const profile = join(repo, 'tmp/fidelity-profile', phase)
  rmSync(dir, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const env = {
    HIDEGPT_FAKE: '1',
    HIDEGPT_HIDDEN: '1',
    HIDEGPT_SCREENSHOT: dir,
    HIDEGPT_PHASE: phase,
    HIDEGPT_FIDELITY_TARGETS: targets,
    TZ: 'UTC',
  }
  const appArgs = [repo, `--user-data-dir=${profile}`, '--lang=en-US']
  const log = join(out, `${phase}.log`)
  const child =
    process.platform === 'darwin'
      ? spawn(
          'open',
          [
            // -g: don't bring it forward; -n: a new instance beside any running Docs; -W: wait for it to quit.
            '-g',
            '-n',
            '-W',
            electron.slice(0, electron.indexOf('.app/') + 4),
            ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
            '--stdout',
            log,
            '--stderr',
            log,
            '--args',
            ...appArgs,
          ],
          { stdio: 'inherit' },
        )
      : spawn(electron, appArgs, { env: { ...process.env, ...env }, stdio: 'inherit' })
  return new Promise((done, fail) => {
    child.on('error', fail)
    child.on('exit', () => {
      const file = join(dir, 'manifest.json')
      done(existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Manifest) : null)
    })
  })
}

if (!values['no-build']) execFileSync('pnpm', ['exec', 'electron-vite', 'build'], { cwd: repo, stdio: 'ignore' })
const started = performance.now()
// Each phase has its own profile and window, so they run side by side.
const results = await Promise.all(
  phases.map(async (phase) => {
    const t0 = performance.now()
    const manifest = await runPhase(phase)
    return { phase, manifest, seconds: (performance.now() - t0) / 1000 }
  }),
)
let failed = false
for (const { phase, manifest, seconds } of results) {
  if (!manifest) {
    failed = true
    console.log(`${phase}: no manifest; see ${join(values.out, `${phase}.log`)}`)
    continue
  }
  console.log(
    `${phase}: ${manifest.shots.length} screens in ${seconds.toFixed(1)}s, ${manifest.failures.length} failed steps`,
  )
  for (const { step, error } of manifest.failures) console.log(`  ${step}: ${error.split('\n')[0]}`)
  if (manifest.failures.length > 0) failed = true
}
console.log(`done in ${((performance.now() - started) / 1000).toFixed(1)}s -> ${values.out}`)
process.exitCode = failed ? 1 : 0
