#!/usr/bin/env node
// The perf bench. Drives a built copy of the app through one fixed session against a
// fake Codex server and reports what it cost. See README.md in this folder.
//
//   node scripts/bench/run.mjs [--repo <dir>] [--label <name>] [--runs 3] [--build]
//   node scripts/bench/run.mjs profile --phase stream300[,open] [--repo <dir>]
//   node scripts/bench/run.mjs compare <before.json> <after.json>
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'

import { launch, sleep } from './launch.mjs'
import { summarizeProfile } from './profile.mjs'
import { compareTable, HEADLINE, resultTable, summarize } from './report.mjs'
import { PHASES, scenario } from './scenario.mjs'

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string', default: process.cwd() },
    label: { type: 'string' },
    runs: { type: 'string', default: '3' },
    out: { type: 'string', default: join(process.cwd(), 'bench-results') },
    build: { type: 'boolean', default: false },
    show: { type: 'boolean', default: false },
    'no-counts': { type: 'boolean', default: false },
    throttle: { type: 'string', default: '1' },
    docs: { type: 'string', default: '500' },
    turns: { type: 'string', default: '300' },
    phase: { type: 'string', default: 'stream300' },
    all: { type: 'boolean', default: false },
  },
})
const command = ['profile', 'compare'].includes(positionals[0]) ? positionals[0] : 'run'

if (command === 'compare') {
  const [before, after] = positionals.slice(1).map((file) => JSON.parse(readFileSync(file, 'utf8')))
  if (!before || !after) throw new Error('usage: run.mjs compare <before.json> <after.json>')
  console.log(compareTable(before, after, { all: flags.all }))
  process.exit(0)
}

const repo = resolve(flags.repo)
const git = (...args) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}
const commit = git('rev-parse', '--short', 'HEAD')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
const label = flags.label ?? (branch === 'HEAD' ? commit : branch)
const out = resolve(flags.out)
const work = join(out, '.work', label)
const docs = Number(flags.docs)
const turns = Number(flags.turns)
const throttle = Number(flags.throttle)

if (flags.build) {
  console.log(`building ${repo} …`)
  execFileSync('pnpm', ['exec', 'electron-vite', 'build', '--sourcemap'], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'] })
}
if (!existsSync(join(repo, 'out', 'main'))) throw new Error(`${repo} is not built; pass --build or run its build first`)
mkdirSync(work, { recursive: true })

/** A fixed loop timed on the wall clock: how contended the machine is right now. */
function spin() {
  const started = performance.now()
  let x = 0
  for (let i = 0; i < 4e7; i += 1) x = (x + i * i) % 1000003
  return performance.now() - started + (x < 0 ? 1 : 0)
}

let current = null
process.on('SIGINT', () => void (current ? current.close().finally(() => process.exit(130)) : process.exit(130)))

/** One launch and one full session. */
async function session(name, { counts = false, around, profileStartup = false } = {}) {
  const noise = { load_before: loadavg()[0], spin_ms: spin() }
  const app = await launch(repo, {
    workDir: work,
    userData: join(work, 'userData'),
    logFile: join(work, `${name}.log`),
    docs,
    turns,
    show: flags.show,
    react: counts,
    ipcBytes: counts,
    throttle,
    profileStartup,
  })
  current = app
  try {
    const metrics = await scenario(app, { docs, around: around?.(app) })
    return { ...metrics, 'noise.load': Math.max(noise.load_before, loadavg()[0]), 'noise.spin_ms': noise.spin_ms }
  } finally {
    current = null
    await app.close()
  }
}

/** Shipped bytes, read from the build output. */
function staticSizes() {
  const walk = (dir) =>
    existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])) : []
  const kb = (files) => files.reduce((sum, file) => sum + statSync(file).size, 0) / 1024
  const gz = (files) => files.reduce((sum, file) => sum + gzipSync(readFileSync(file)).length, 0) / 1024
  const renderer = walk(join(repo, 'out', 'renderer'))
  const html = renderer.find((file) => file.endsWith('index.html'))
  // The entry and its modulepreloads load before first paint; every other chunk is lazy.
  const eager = html ? [...readFileSync(html, 'utf8').matchAll(/(?:src|href)="[^"]*?([^"/]+\.js)"/g)].map((match) => match[1]) : []
  const js = renderer.filter((file) => file.endsWith('.js'))
  const entry = js.filter((file) => eager.some((name) => file.endsWith(name)))
  const lazy = js.filter((file) => !entry.includes(file))
  const css = renderer.filter((file) => file.endsWith('.css'))
  const fonts = renderer.filter((file) => /\.(woff2?|ttf|otf)$/.test(file))
  const mainJs = walk(join(repo, 'out', 'main')).filter((file) => file.endsWith('.js'))
  const preload = walk(join(repo, 'out', 'preload')).filter((file) => /\.(c|m)?js$/.test(file))
  return {
    'static.renderer_entry_js_kb': kb(entry),
    'static.renderer_entry_js_gz_kb': gz(entry),
    'static.renderer_lazy_js_kb': kb(lazy),
    'static.renderer_css_kb': kb(css),
    'static.renderer_css_gz_kb': gz(css),
    'static.renderer_fonts_kb': kb(fonts),
    'static.renderer_font_files': fonts.length,
    'static.main_js_kb': kb(mainJs),
    'static.main_largest_chunk_kb': Math.max(0, ...mainJs.map((file) => statSync(file).size / 1024)),
    'static.preload_kb': kb(preload),
  }
}

if (command === 'profile') {
  const phases = flags.phase.split(',')
  const unknown = phases.filter((phase) => !PHASES.includes(phase))
  if (unknown.length) throw new Error(`unknown phase ${unknown.join(', ')}; phases are: ${PHASES.join(', ')}`)
  const fileOf = (phase, proc) => join(out, `${label}.${phase}.${proc}.cpuprofile`)
  await session('profile', {
    profileStartup: phases.includes('cold'),
    around: (app) => async (phase, run) => {
      if (!phases.includes(phase)) return run()
      if (phase === 'cold') {
        // Main was profiled from its first line (hook.cjs). The page cannot be attached to
        // that early, so its start-up is profiled on a reload: same modules, same first render.
        const result = await run()
        await app.main('profileStop', { file: fileOf(phase, 'main') })
        await app.page.send('Profiler.enable')
        await app.page.send('Profiler.setSamplingInterval', { interval: 250 })
        await app.page.send('Profiler.start')
        await app.page.send('Page.reload', { ignoreCache: true })
        // Every card, or (a Home that mounts only the cards in view) a while after the first ones.
        for (let i = 0; i < 400; i += 1) {
          const cold = await app.bench('cold()').catch(() => null)
          if (cold?.allCards || (cold?.firstCard && Date.now() - cold.firstCard > 750)) break
          await sleep(50)
        }
        const { profile } = await app.page.send('Profiler.stop')
        writeFileSync(fileOf(phase, 'renderer'), JSON.stringify(profile))
        return result
      }
      await app.page.send('Profiler.enable')
      await app.page.send('Profiler.setSamplingInterval', { interval: 250 })
      await app.page.send('Profiler.start')
      await app.main('profileStart')
      try {
        return await run()
      } finally {
        const { profile } = await app.page.send('Profiler.stop')
        writeFileSync(fileOf(phase, 'renderer'), JSON.stringify(profile))
        await app.main('profileStop', { file: fileOf(phase, 'main') })
      }
    },
  })
  for (const phase of phases) {
    for (const proc of ['renderer', 'main']) {
      const file = fileOf(phase, proc)
      const text = `## ${label} ${phase}: ${proc} process\n\n${summarizeProfile(file, repo)}\n`
      writeFileSync(file.replace('.cpuprofile', '.md'), text)
      console.log(text)
    }
  }
  process.exit(0)
}

// ---- run ----
const runs = []
const total = Number(flags.runs)
// The first launch fills the V8 compile cache; only its start-up numbers are kept, apart.
rmSync(join(work, 'userData'), { recursive: true, force: true })
console.log(`${label} (${commit}): ${total} timing runs${flags['no-counts'] ? '' : ' + 1 counts run'}, ${docs} docs, ${turns} turns${throttle > 1 ? `, ${throttle}x CPU throttle` : ''}`)
for (let i = 0; i <= total; i += 1) {
  const started = Date.now()
  const metrics = await session(`run-${i}`)
  runs.push(metrics)
  const note = i === 0 ? ' (first launch, start-up kept apart)' : ''
  console.log(`  run ${i}: ${((Date.now() - started) / 1000).toFixed(0)} s, load ${metrics['noise.load'].toFixed(1)}, spin ${metrics['noise.spin_ms'].toFixed(0)} ms${note}`)
}
const [first, ...timed] = runs
const counts = flags['no-counts'] ? null : await session('counts', { counts: true })
if (counts) console.log('  counts run done')

const result = {
  label,
  repo,
  branch,
  commit,
  when: new Date().toISOString(),
  machine: { cpu: cpus()[0]?.model, cores: cpus().length, memory_gb: Math.round(totalmem() / 2 ** 30), platform: `${process.platform} ${process.arch}`, node: process.version },
  options: { runs: total, docs, turns, throttle, shown: flags.show },
  summary: summarize(timed),
  first_launch: Object.fromEntries(Object.entries(first).filter(([name]) => name.startsWith('cold.'))),
  counts,
  static: staticSizes(),
  runs: timed,
}
mkdirSync(out, { recursive: true })
writeFileSync(join(out, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`)
writeFileSync(join(out, `${label}.md`), resultTable(result, { all: true }))
console.log(`\n${resultTable(result, { only: HEADLINE })}`)
console.log(`full results: ${join(out, `${label}.json`)} and .md`)
