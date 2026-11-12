// Loaded into the app's main process by the perf bench (`electron -r hook.cjs <repo>`),
// before any app code. It changes no app behaviour that the bench measures; it only
//   - keeps the run away from real data: its own userData folder, and every child
//     process the app starts is either the bench's fake Codex server or refused;
//   - keeps the window off screen (never shown, never focused) but still rendering;
//   - counts IPC to the window, main-thread event-loop delay and startup marks;
//   - answers the bench's requests over a local control socket.
const { app, session, contentTracing } = require('electron')
const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')
const net = require('node:net')
const path = require('node:path')
const { monitorEventLoopDelay } = require('node:perf_hooks')
const readline = require('node:readline')

const env = process.env
const now = () => performance.timeOrigin + performance.now()
const marks = { processStart: performance.timeOrigin, hook: now() }

if (env.BENCH_USER_DATA) app.setPath('userData', env.BENCH_USER_DATA)
// No Dock icon either: the bench must not be noticeable on a machine someone is using.
if (env.BENCH_SHOW !== '1') app.dock?.hide()
// The window is never shown, so Chromium must not treat it as a background tab.
for (const flag of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) {
  app.commandLine.appendSwitch(flag)
}
app.commandLine.appendSwitch('remote-debugging-port', env.BENCH_CDP_PORT ?? '0')
app.commandLine.appendSwitch('js-flags', '--expose-gc')

// ---- no real provider ever starts under the bench ----
const FAKE = env.BENCH_FAKE_CODEX
const isCodex = (command) => path.basename(String(command)) === 'codex' || command === FAKE
const blocked = []
function guard(name) {
  const original = childProcess[name]
  childProcess[name] = function (command, ...rest) {
    if (isCodex(command)) return original.call(this, FAKE, ...rest)
    blocked.push(String(command))
    // A missing binary: the app sees the same ENOENT it would on a machine without the provider.
    return original.call(this, path.join('/nonexistent', `bench-blocked-${path.basename(String(command))}`), ...rest)
  }
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) guard(name)
syncBuiltinESMExports()

// ---- window: hidden, fixed size, IPC counted ----
const ipc = { sends: 0, bytes: 0, byChannel: {}, measureMs: 0 }
const COUNT_BYTES = env.BENCH_IPC_BYTES === '1'
let win = null
app.on('browser-window-created', (_event, created) => {
  if (win) return
  win = created
  marks.windowCreated = now()
  if (env.BENCH_SHOW !== '1') {
    created.show = () => {}
    created.focus = () => {}
  }
  created.setSize(Number(env.BENCH_WIDTH ?? 1440), Number(env.BENCH_HEIGHT ?? 900))
  const contents = created.webContents
  contents.setBackgroundThrottling(false)
  created.once('ready-to-show', () => (marks.readyToShow = now()))
  contents.once('dom-ready', () => (marks.domReady = now()))
  contents.once('did-finish-load', () => (marks.didFinishLoad = now()))
  const send = contents.send.bind(contents)
  contents.send = (channel, ...args) => {
    ipc.sends += 1
    ipc.byChannel[channel] = (ipc.byChannel[channel] ?? 0) + 1
    if (COUNT_BYTES) {
      // JSON length stands in for the structured-clone size; its own cost is reported so CPU can exclude it.
      const t = performance.now()
      ipc.bytes += JSON.stringify(args).length
      ipc.measureMs += performance.now() - t
    }
    send(channel, ...args)
  }
})

app.on('ready', () => {
  marks.ready = now()
  // Registered before the app creates its window, so the probe is in every page from the start.
  const probe = path.join(__dirname, 'probe.cjs')
  const ses = session.defaultSession
  if (ses.registerPreloadScript) ses.registerPreloadScript({ type: 'frame', filePath: probe })
  else ses.setPreloads([probe])
})

// ---- control socket ----
const delay = monitorEventLoopDelay({ resolution: 5 })
delay.enable()
let profiler = null
/** Starts V8's sampling profiler in this process. Posts on an in-process session run at once. */
function startProfiler() {
  const { Session } = require('node:inspector')
  profiler = new Session()
  profiler.connect()
  profiler.post('Profiler.enable')
  profiler.post('Profiler.setSamplingInterval', { interval: 250 })
  profiler.post('Profiler.start')
}
// Start-up is profiled from here, before any app module loads.
if (env.BENCH_PROFILE_STARTUP === '1') startProfiler()

const ops = {
  stats() {
    const cpu = process.cpuUsage()
    const lag = { p50: delay.percentile(50) / 1e6, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6, mean: delay.mean / 1e6, samples: delay.count }
    const memory = process.memoryUsage()
    return {
      marks,
      blocked,
      ipc: { ...ipc, byChannel: { ...ipc.byChannel } },
      mainCpuMs: (cpu.user + cpu.system) / 1000,
      lag,
      mainHeapMb: memory.heapUsed / 1048576,
      pids: {
        main: process.pid,
        renderer: win?.webContents.getOSProcessId() ?? null,
        gpu: app.getAppMetrics().find((item) => item.type === 'GPU')?.pid ?? null,
      },
    }
  },
  resetLag() {
    delay.reset()
    return true
  },
  gc() {
    globalThis.gc?.()
    return true
  },
  async traceStart({ categories }) {
    await contentTracing.startRecording({ included_categories: categories })
    return true
  },
  async traceStop({ file }) {
    return contentTracing.stopRecording(file)
  },
  profileStart() {
    startProfiler()
    return true
  },
  async profileStop({ file }) {
    const result = await new Promise((resolve, reject) => profiler.post('Profiler.stop', (error, value) => (error ? reject(error) : resolve(value))))
    require('node:fs').writeFileSync(file, JSON.stringify(result.profile))
    profiler.disconnect()
    profiler = null
    return file
  },
  quit() {
    setTimeout(() => app.quit(), 0)
    return true
  },
}

if (env.BENCH_CONTROL) {
  const socket = net.connect(Number(env.BENCH_CONTROL), '127.0.0.1')
  const tell = (message) => socket.write(`${JSON.stringify(message)}\n`)
  socket.on('error', () => {})
  // The bench went away (finished, failed or was interrupted): never outlive it.
  socket.on('close', () => {
    app.quit()
    setTimeout(() => app.exit(0), 6000).unref()
  })
  socket.on('connect', () => tell({ role: 'main', pid: process.pid }))
  readline.createInterface({ input: socket }).on('line', async (line) => {
    const { id, op, args } = JSON.parse(line)
    try {
      tell({ id, result: await ops[op](args ?? {}) })
    } catch (error) {
      tell({ id, error: String(error?.stack ?? error) })
    }
  })
}
