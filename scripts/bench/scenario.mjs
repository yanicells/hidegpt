// The session the perf bench drives, one phase per user-visible action. Every phase
// writes flat `phase.metric` numbers into `metrics`; see README.md for what each means.
import { sleep } from './launch.mjs'

const CARD = '[data-testid^="thread-"]'
const BLOCK = '.doc-block'
const HOME = ['.doc-home', '.tabs-back']
const call = (name, args) => `${name}(${JSON.stringify(args)})`

/** The phases in order. `--profile` and `--trace` take one of these names. */
export const PHASES = [
  'cold',
  'home_list',
  'home_grid',
  'open',
  'type_idle',
  'stream30',
  'code30',
  'load_all',
  'stream300',
  'type_stream300',
  'type_idle300',
  'scroll300',
  'to_home',
  'open_other',
  'reopen',
]

/**
 * Runs the whole session against a launched app. `around(phase, run)` lets the caller
 * wrap one phase (profiling, tracing); it must call `run()`.
 */
export async function scenario(app, { docs, around = (_phase, run) => run() }) {
  const { page, bench, main, measure } = app
  const metrics = {}
  const set = (name, value) => (metrics[name] = value)
  const started = Date.now()
  const log = (name) => process.env.BENCH_DEBUG && console.error(`    +${((Date.now() - started) / 1000).toFixed(1)}s ${name}`)
  const phase = (name, step, options) => (log(name), around(name, () => measure(metrics, name, step, options)))

  // ---- keyboard, through the same input path as a real key press ----
  async function press(key, code, virtualKey, text) {
    const base = { key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey }
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
  const letter = (char) => press(char, `Key${char.toUpperCase()}`, char.toUpperCase().charCodeAt(0), char)
  const enter = () => press('Enter', 'Enter', 13, '\r')
  async function clearComposer() {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    await press('Backspace', 'Backspace', 8)
  }
  /** Types one key every 100 ms until `count` keys or `until` settles; records key-to-paint latency. */
  async function typeKeys(name, { count = Infinity, until = null }) {
    if (!(await bench('focusComposer()'))) throw new Error('the composer could not be focused')
    await bench('keysArm(true)')
    let stop = false
    void until?.then(() => (stop = true))
    const started = performance.now()
    for (let i = 0; i < count && !stop; i += 1) {
      await letter('abcdefghij'[i % 10])
      await sleep(Math.max(0, started + (i + 1) * 100 - performance.now()))
    }
    await sleep(150)
    const keys = await bench('keysTake()')
    await bench('keysArm(false)')
    set(`${name}.keys`, keys.n)
    set(`${name}.key_p50_ms`, keys.p50)
    set(`${name}.key_p95_ms`, keys.p95)
    set(`${name}.key_max_ms`, keys.max)
  }

  /** Asks a question and waits until the scripted answer is fully on the page. */
  async function ask(name, plan, { typing = false } = {}) {
    const sentinel = `fin-${name}-${Date.now()}`
    app.codex.plan({ ...plan, sentinel })
    await bench('focusComposer()')
    await clearComposer()
    await page.send('Input.insertText', { text: 'Explain the main idea again in more detail' })
    const blocks = await bench(`count(${JSON.stringify(BLOCK)})`)
    await phase(
      name,
      async () => {
        const painted = bench(call('waitFor', { text: sentinel, timeout: 120000 })).catch(async (error) => {
          throw new Error(`${name}: the answer never finished: ${error.message}; last block ${JSON.stringify(await bench('lastBlock()'))}`)
        })
        const sent = Date.now()
        await enter()
        if (typing) await typeKeys(name, { until: painted })
        const [seen, done] = await Promise.all([painted, app.codex.next()])
        set(`${name}.stream_ms`, done.streamMs)
        set(`${name}.deltas`, done.deltas)
        set(`${name}.chars`, done.chars)
        // How long after the server finished the last character reached the page.
        set(`${name}.end_lag_ms`, seen.first - done.emittedAt)
        set(`${name}.total_ms`, seen.first - sent)
        await sleep(300)
      },
      { frames: true },
    )
    if (typing) await clearComposer()
    set(`${name}.blocks_added`, (await bench(`count(${JSON.stringify(BLOCK)})`)) - blocks)
  }

  /** Clicks, then times the first paint that satisfies `wait` and the paint after the page went quiet. */
  async function click(name, selector, wait) {
    const seen = await phase(name, () => bench(call('clickWatch', { click: selector, quietMs: 250, timeout: 30000, ...wait })), { frames: true })
    set(`${name}.first_ms`, seen.first)
    set(`${name}.settled_ms`, seen.settled)
    return seen
  }

  async function memory(name) {
    await page.send('HeapProfiler.collectGarbage')
    await main('gc')
    await sleep(500)
    const { perf, stats } = await app.counters()
    const footprint = await app.footprints()
    const dom = await bench('dom()')
    set(`${name}.r_heap_mb`, perf.JSHeapUsedSize / 1048576)
    set(`${name}.m_heap_mb`, stats.mainHeapMb)
    set(`${name}.r_footprint_mb`, footprint.renderer)
    set(`${name}.m_footprint_mb`, footprint.main)
    set(`${name}.g_footprint_mb`, footprint.gpu)
    set(`${name}.dom_nodes`, dom.nodes)
    set(`${name}.blocks`, dom.blocks)
  }

  // ---- cold start: everything from the process starting to the library on screen ----
  log('cold')
  await around('cold', async () => {
    let cold = null
    for (const deadline = Date.now() + 30000; ; await sleep(50)) {
      cold = await bench('cold()')
      if (cold.allCards) break
      if (cold.error || Date.now() > deadline) throw new Error(`cold start: the library never appeared (${cold.error ?? 'timeout'})`)
    }
    await sleep(1500)
    const { stats, used, perf } = await app.counters()
    const since = (t) => (t ? t - app.t0 : null)
    // The renderer's main thread since the page started: where its start-up time went.
    set('cold.script_ms', perf.ScriptDuration * 1000)
    set('cold.layout_ms', perf.LayoutDuration * 1000)
    set('cold.recalc_ms', perf.RecalcStyleDuration * 1000)
    set('cold.task_ms', perf.TaskDuration * 1000)
    set('cold.layouts', perf.LayoutCount)
    set('cold.recalcs', perf.RecalcStyleCount)
    set('cold.process_ms', since(stats.marks.processStart))
    set('cold.app_ready_ms', since(stats.marks.ready))
    set('cold.window_ms', since(stats.marks.windowCreated))
    set('cold.dom_ready_ms', since(stats.marks.domReady))
    set('cold.fcp_ms', since(cold['first-contentful-paint'] ?? cold['first-paint']))
    set('cold.first_card_ms', since(cold.firstCard))
    set('cold.all_cards_ms', since(cold.allCards))
    // Cumulative since each process started, read 1.5 s after the library painted.
    for (const [short, pid] of [['r', app.pids.renderer], ['m', app.pids.main], ['g', app.pids.gpu]]) {
      if (!used[pid]) continue
      set(`cold.${short}_ginstr`, used[pid].instructions / 1e9)
      set(`cold.${short}_cpu_ms`, used[pid].cpu_ms)
    }
    set('cold.lag_max_ms', Math.max(0, stats.lag.max - 5))
    set('cold.ipc_sends', stats.ipc.sends)
    if (stats.ipc.bytes) set('cold.ipc_kb', stats.ipc.bytes / 1024)
    set('cold.cards', await bench(`count(${JSON.stringify(CARD)})`))
    if (stats.blocked.length) set('cold.blocked_spawns', stats.blocked.length)
    // Which programs the app tried to start (a name list, so it stays out of the tables).
    if (stats.blocked.length) set('cold.blocked', stats.blocked.join(', '))
  })
  await memory('mem_home')

  // ---- Home with the whole library ----
  await click('home_list', '[aria-label="List view"]', { selector: '.list-row' })
  await click('home_grid', '[aria-label="Grid view"]', { gone: '.list-row' })

  // ---- the long document: open (newest page), type, stream ----
  await click('open', '[data-testid="thread-doc-0"]', { selector: BLOCK })
  set('open.blocks', await bench(`count(${JSON.stringify(BLOCK)})`))
  await phase('type_idle', () => typeKeys('type_idle', { count: 30 }), { frames: true })
  await ask('stream30', { kind: 'prose' })
  await ask('code30', { kind: 'code' })

  // ---- page in the rest of the document ----
  await phase(
    'load_all',
    async () => {
      const pages = []
      const started = Date.now()
      while (pages.length < 40 && (await bench('has(\'[data-testid="load-older"]\')'))) {
        const seen = await bench(call('clickWatch', { click: '[data-testid="load-older"]', selector: BLOCK, gt: true, quietMs: 250, timeout: 30000 }))
        pages.push(seen.settled)
      }
      pages.sort((a, b) => a - b)
      set('load_all.pages', pages.length)
      set('load_all.page_p50_ms', pages[Math.floor(pages.length / 2)] ?? 0)
      set('load_all.page_max_ms', pages[pages.length - 1] ?? 0)
      // The quiet wait after each page is the bench's, not the app's.
      set('load_all.total_ms', Date.now() - started - pages.length * 250)
    },
    { frames: true },
  )
  await memory('mem300')

  // ---- the same work with the whole document loaded ----
  await ask('stream300', { kind: 'prose' })
  await ask('type_stream300', { kind: 'prose', answers: 2 }, { typing: true })
  await phase('type_idle300', () => typeKeys('type_idle300', { count: 30 }), { frames: true })
  await clearComposer()
  await phase('scroll300', () => bench(call('scrollRun', { step: -600, frames: 150 })), { frames: true })

  // ---- moving between documents ----
  await click('to_home', HOME, { selector: CARD, count: Math.min(docs, 20) })
  await click('open_other', '[data-testid="thread-doc-1"]', { selector: BLOCK })
  await bench(call('clickWatch', { click: HOME, selector: CARD, quietMs: 250 }))
  await click('reopen', '[data-testid="thread-doc-0"]', { selector: BLOCK })
  await bench(call('clickWatch', { click: HOME, selector: CARD, quietMs: 250 }))
  await memory('mem_end')

  set('requests', { ...app.requests })
  return metrics
}
