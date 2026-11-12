// Starts one instance of the app under test for the perf bench and returns the handles
// a scenario needs: the page (DevTools protocol), the main process (control socket in
// hook.cjs), the fake Codex server, and `measure`, which wraps a step in every counter.
import { spawn } from 'node:child_process'
import { chmodSync, createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { connectPage } from './cdp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A free local port: bind to 0, read it, release it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Long-running reader of per-process counters (instructions retired, CPU time, footprint). */
function startUsageReader() {
  if (process.platform !== 'darwin') return { read: async () => ({}), stop() {} }
  const child = spawn('python3', [join(here, 'rusage.py')], { stdio: ['pipe', 'pipe', 'ignore'] })
  const waiting = []
  let dead = false
  child.on('error', () => (dead = true))
  child.on('exit', () => {
    dead = true
    for (const resolve of waiting.splice(0)) resolve({})
  })
  createInterface({ input: child.stdout }).on('line', (line) => waiting.shift()?.(JSON.parse(line)))
  return {
    read: (pids) =>
      dead
        ? Promise.resolve({})
        : new Promise((resolve) => {
            waiting.push(resolve)
            child.stdin.write(`${pids.join(' ')}\n`)
          }),
    stop: () => child.stdin.end(),
  }
}

/**
 * Launches `<repo>` (already built) against the fake Codex server.
 * `options`: workDir, userData, logFile, docs, turns, show, react, ipcBytes, throttle, profileStartup.
 */
export async function launch(repo, options) {
  const workDir = options.workDir
  mkdirSync(workDir, { recursive: true })
  const [controlPort, cdpPort] = await Promise.all([freePort(), freePort()])

  // ---- control server: the hook (main) and the fake Codex server both dial in ----
  let mainSocket = null
  let codexHello = null
  let nextId = 0
  const pending = new Map()
  const codexEvents = []
  const codexWaiters = []
  const requests = {}
  const hello = { main: Promise.withResolvers(), codex: Promise.withResolvers() }
  const server = createServer((socket) => {
    let role = null
    socket.on('error', () => {})
    createInterface({ input: socket }).on('line', (line) => {
      const message = JSON.parse(line)
      if (role === null) {
        role = message.role
        if (role === 'main') mainSocket = socket
        else codexHello = { ...message, socket }
        return hello[role]?.resolve(message)
      }
      if (role === 'main') {
        const waiter = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) waiter?.reject(new Error(message.error))
        else waiter?.resolve(message.result)
      } else if (message.event === 'request') {
        requests[message.method] = (requests[message.method] ?? 0) + 1
      } else {
        const waiter = codexWaiters.shift()
        if (waiter) waiter(message)
        else codexEvents.push(message)
      }
    })
  })
  await new Promise((resolve) => server.listen(controlPort, '127.0.0.1', resolve))

  // The app starts `codex app-server`; this is what it gets instead.
  const fakeCodex = join(workDir, 'codex')
  writeFileSync(
    fakeCodex,
    `#!/bin/sh\nBENCH_CONTROL=${controlPort} BENCH_DOCS=${options.docs} BENCH_TURNS=${options.turns} exec "${process.execPath}" "${join(here, 'fake-codex.mjs')}" "$@"\n`,
  )
  chmodSync(fakeCodex, 0o755)

  const electron = createRequire(join(repo, 'package.json'))('electron')
  const env = {
    ...process.env,
    CODEX_BIN: fakeCodex,
    BENCH_FAKE_CODEX: fakeCodex,
    BENCH_CONTROL: String(controlPort),
    BENCH_CDP_PORT: String(cdpPort),
    BENCH_USER_DATA: options.userData,
    BENCH_DOCS: String(options.docs),
    BENCH_SHOW: options.show ? '1' : '0',
    BENCH_REACT: options.react ? '1' : '0',
    BENCH_IPC_BYTES: options.ipcBytes ? '1' : '0',
    BENCH_PROFILE_STARTUP: options.profileStartup ? '1' : '0',
  }
  // The bench drives the real provider path; the in-process demo and screenshot modes must stay off.
  delete env.HIDEGPT_FAKE
  delete env.HIDEGPT_SCREENSHOT
  delete env.ELECTRON_RUN_AS_NODE
  const t0 = Date.now()
  const child = spawn(electron, ['-r', join(here, 'hook.cjs'), repo], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.pipe(createWriteStream(options.logFile))
  const exited = new Promise((resolve) => child.once('exit', resolve))
  let page = null
  // A dead app fails every call that is waiting on it, so a crash ends the run instead of hanging it.
  void exited.then(() => {
    for (const waiter of pending.values()) waiter.reject(new Error(`the app exited (app log: ${options.logFile})`))
    pending.clear()
    page?.close()
  })
  const within = async (promise, ms, what) => {
    let timer = null
    const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out ${what}`)), ms)))
    const gone = exited.then(() => Promise.reject(new Error(`the app exited while ${what}`)))
    try {
      return await Promise.race([promise, late, gone])
    } catch (error) {
      child.kill('SIGKILL')
      server.close()
      throw new Error(`${error.message} (app log: ${options.logFile})`)
    } finally {
      clearTimeout(timer)
    }
  }

  await within(hello.main.promise, 30000, 'waiting for the app to start')
  // Nothing is typed into the app until its Codex connection is known to be the fake.
  await within(hello.codex.promise, 30000, 'waiting for the app to start the fake Codex server')
  page = await within(connectPage(cdpPort), 30000, 'waiting for the app window')
  await page.send('Performance.enable', { timeDomain: 'threadTicks' })
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  if (options.throttle > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: options.throttle })

  const main = (op, args) =>
    new Promise((resolve, reject) => {
      const id = (nextId += 1)
      pending.set(id, { resolve, reject })
      mainSocket.write(`${JSON.stringify({ id, op, args })}\n`)
    })
  const bench = (call) => page.evaluate(`window.__bench.${call}`)
  const usage = startUsageReader()
  const { pids } = await main('stats')

  async function counters() {
    const [stats, perf, used] = await Promise.all([
      main('stats'),
      page.send('Performance.getMetrics'),
      usage.read([pids.main, pids.renderer, pids.gpu].filter(Boolean)),
    ])
    return { stats, perf: Object.fromEntries(perf.metrics.map((metric) => [metric.name, metric.value])), used }
  }

  /**
   * Runs `step` and records what it cost under `prefix`: instructions retired and CPU
   * time per process, Blink layout and style counts, IPC to the window, main-thread
   * event-loop delay, and (with `frames`) frame intervals and long tasks.
   */
  async function measure(metrics, prefix, step, { frames = false, react = options.react } = {}) {
    await main('resetLag')
    if (frames) await bench('recordStart()')
    if (react) await bench('reactStart()')
    const before = await counters()
    const result = await step()
    const after = await counters()
    const set = (name, value) => (metrics[`${prefix}.${name}`] = value)
    for (const [short, pid] of [['r', pids.renderer], ['m', pids.main], ['g', pids.gpu]]) {
      const a = before.used[pid]
      const b = after.used[pid]
      if (!a || !b) continue
      set(`${short}_ginstr`, (b.instructions - a.instructions) / 1e9)
      set(`${short}_cpu_ms`, b.cpu_ms - a.cpu_ms)
    }
    const delta = (name) => after.perf[name] - before.perf[name]
    set('layouts', delta('LayoutCount'))
    set('recalcs', delta('RecalcStyleCount'))
    set('layout_ms', delta('LayoutDuration') * 1000)
    set('recalc_ms', delta('RecalcStyleDuration') * 1000)
    set('script_ms', delta('ScriptDuration') * 1000)
    set('task_ms', delta('TaskDuration') * 1000)
    set('ipc_sends', after.stats.ipc.sends - before.stats.ipc.sends)
    if (options.ipcBytes) set('ipc_kb', (after.stats.ipc.bytes - before.stats.ipc.bytes) / 1024)
    // The delay monitor fires every 5 ms; anything past that is the loop being busy.
    set('lag_p99_ms', Math.max(0, after.stats.lag.p99 - 5))
    set('lag_max_ms', Math.max(0, after.stats.lag.max - 5))
    if (frames) {
      const rec = await bench('recordStop()')
      set('frames', rec.frames.n)
      set('frame_p50_ms', rec.frames.p50)
      set('frame_p95_ms', rec.frames.p95)
      set('frame_max_ms', rec.frames.max)
      set('late_frames', rec.late)
      set('janky_frames', rec.janky)
      set('longtasks', rec.longtasks.n)
      set('longtask_max_ms', rec.longtasks.max)
      set('longtask_sum_ms', rec.longtasks.sum)
    }
    if (react) {
      const counted = await bench('react()')
      if (counted) {
        set('commits', counted.commits)
        set('renders', counted.renders)
        metrics[`${prefix}.render_top`] = counted.top
      }
    }
    return result
  }

  return {
    t0,
    pids,
    page,
    main,
    bench,
    measure,
    counters,
    requests,
    footprints: async () => {
      const used = await usage.read([pids.main, pids.renderer, pids.gpu].filter(Boolean))
      return { main: used[pids.main]?.footprint_mb, renderer: used[pids.renderer]?.footprint_mb, gpu: used[pids.gpu]?.footprint_mb }
    },
    codex: {
      hello: () => codexHello,
      /** Scripts the answer to the next question the app sends. */
      plan: (plan) => codexHello.socket.write(`${JSON.stringify({ op: 'plan', ...plan })}\n`),
      /** The next event from the fake server (`turnDone`). */
      next: () => (codexEvents.length ? Promise.resolve(codexEvents.shift()) : new Promise((resolve) => codexWaiters.push(resolve))),
    },
    async close() {
      usage.stop()
      page.close()
      await main('quit').catch(() => {})
      // The app closes its provider processes on quit; past its own deadline it is stopped by pid.
      const done = await Promise.race([exited.then(() => true), sleep(8000).then(() => false)])
      if (!done) child.kill('SIGKILL')
      server.close()
      for (const socket of [mainSocket, codexHello?.socket]) socket?.destroy()
    },
  }
}
