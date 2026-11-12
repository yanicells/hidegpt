// The perf bench's renderer probe: an extra sandboxed preload (isolated world) that the
// bench hook registers on the session. It never calls app code. It watches the shared
// DOM and performance timeline, and exposes `window.__bench` so the bench can drive and
// read it over the DevTools protocol.
const { contextBridge } = require('electron')

const now = () => performance.timeOrigin + performance.now()
/** Epoch ms just after the next frame is produced (rAF, then a task: after the commit). */
const afterPaint = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => resolve(now())
      channel.port2.postMessage(0)
    }),
  )

const observe = (type, onEntries, extra) => {
  try {
    new PerformanceObserver((list) => onEntries(list.getEntries())).observe({ type, ...extra })
  } catch {
    // This Chromium does not report the entry type.
  }
}

// ---- frames, long tasks ----
const rec = { on: false, run: 0, frames: [], longtasks: [], last: 0 }
observe('longtask', (entries) => rec.on && entries.forEach((entry) => rec.longtasks.push(entry.duration)))
/** One loop per recording: a loop from an earlier recording sees a newer `run` and stops. */
function frameLoop(run) {
  requestAnimationFrame((t) => {
    if (!rec.on || rec.run !== run) return
    if (rec.last) rec.frames.push(t - rec.last)
    rec.last = t
    frameLoop(run)
  })
}
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0)
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.length ? sorted[sorted.length - 1] : 0, sum: sorted.reduce((a, b) => a + b, 0) }
}

// ---- typing: keydown timestamp → the frame after the text changed ----
const keys = { armed: false, last: null, latencies: [] }
addEventListener('keydown', (event) => keys.armed && (keys.last = event.timeStamp), true)
addEventListener(
  'input',
  () => {
    const start = keys.last
    keys.last = null
    if (start === null) return
    void afterPaint().then((t) => keys.latencies.push(t - performance.timeOrigin - start))
  },
  true,
)

// ---- waiting on the DOM ----
const all = (selector) => document.querySelectorAll(selector)
const first = (selectors) => {
  for (const selector of [].concat(selectors)) {
    const el = document.querySelector(selector)
    if (el) return el
  }
  return null
}
const lastBlockHas = (text) => {
  const blocks = all('.doc-block')
  const last = blocks[blocks.length - 1]
  return !!last && last.textContent.includes(text) && !last.querySelector('.caret')
}
function condition({ selector, count = 1, gt, text, gone }) {
  const before = selector ? all(selector).length : 0
  return () =>
    (!selector || (gt ? all(selector).length > before : all(selector).length >= count)) &&
    (!text || lastBlockHas(text)) &&
    (!gone || !document.querySelector(gone))
}

/**
 * Watches until `check()` holds and the DOM then stays unchanged for `quietMs`.
 * `first` is the paint after the check first held; `settled` is the paint after the
 * last change, so progressive rendering counts until its final row.
 */
function watch(check, { timeout = 60000, quietMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let firstAt = null
    let lastChange = null
    let quiet = null
    let done = false
    const finish = () => {
      if (done) return
      done = true
      observer.disconnect()
      clearTimeout(timer)
      void Promise.all([firstAt, lastChange]).then(([seen, settled]) => resolve({ first: seen, settled }))
    }
    const onChange = () => {
      if (firstAt === null) {
        if (!check()) return
        firstAt = afterPaint()
      }
      lastChange = afterPaint()
      if (!quietMs) return finish()
      clearTimeout(quiet)
      quiet = setTimeout(finish, quietMs)
    }
    const observer = new MutationObserver(onChange)
    observer.observe(document, { childList: true, subtree: true, characterData: true })
    const timer = setTimeout(() => {
      observer.disconnect()
      reject(new Error('timed out waiting for the page'))
    }, timeout)
    onChange()
  })
}

const cold = { timeOrigin: performance.timeOrigin }
observe('paint', (entries) => entries.forEach((entry) => (cold[entry.name] = performance.timeOrigin + entry.startTime)), { buffered: true })
const CARD = '[data-testid^="thread-"]'
const docsWanted = Number(process.env.BENCH_DOCS || 500)
watch(() => all(CARD).length >= 1)
  .then((seen) => {
    cold.firstCard = seen.first
    return watch(() => all(CARD).length >= docsWanted)
  })
  .then((seen) => (cold.allCards = seen.first))
  .catch((error) => (cold.error = String(error)))

const api = {
  cold() {
    const [navigation] = performance.getEntriesByType('navigation')
    return {
      ...cold,
      responseEnd: navigation ? performance.timeOrigin + navigation.responseEnd : null,
      domInteractive: navigation ? performance.timeOrigin + navigation.domInteractive : null,
      domContentLoaded: navigation ? performance.timeOrigin + navigation.domContentLoadedEventEnd : null,
      loadEvent: navigation ? performance.timeOrigin + navigation.loadEventEnd : null,
    }
  },
  count: (selector) => all(selector).length,
  has: (selectors) => !!first(selectors),
  /** Clicks the first matching element and resolves once the condition holds (see `watch`). */
  async clickWatch(args) {
    const el = first(args.click)
    if (!el) throw new Error(`no element ${args.click}`)
    const check = condition(args)
    const t0 = now()
    el.click()
    const seen = await watch(check, args)
    return { t0, first: seen.first - t0, settled: seen.settled - t0 }
  },
  async waitFor(args) {
    const seen = await watch(condition(args), args)
    return { first: seen.first, settled: seen.settled }
  },
  recordStart() {
    Object.assign(rec, { on: true, run: rec.run + 1, frames: [], longtasks: [], last: 0 })
    frameLoop(rec.run)
    return true
  },
  recordStop() {
    rec.on = false
    return {
      frames: stats(rec.frames),
      // A frame is late past 1.5 display intervals, and janky past 50 ms.
      late: rec.frames.filter((frame) => frame > 25).length,
      janky: rec.frames.filter((frame) => frame > 50).length,
      longtasks: stats(rec.longtasks),
    }
  },
  keysArm(on) {
    keys.armed = on
    if (on) Object.assign(keys, { last: null, latencies: [] })
    return true
  },
  keysTake: () => stats(keys.latencies),
  focusComposer() {
    const el = document.querySelector('[data-testid="composer"]')
    el?.focus({ preventScroll: true })
    return document.activeElement === el
  },
  dom: () => ({ nodes: document.getElementsByTagName('*').length, blocks: all('.doc-block').length }),
  scrollInfo() {
    const el = document.querySelector('[data-testid="document"]')
    return el ? { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } : null
  },
  /** Scrolls the document by `step` px on each of `frames` frames (negative is up). */
  scrollRun({ step, frames }) {
    const el = document.querySelector('[data-testid="document"]')
    if (!el) throw new Error('no document is open')
    return new Promise((resolve) => {
      let left = frames
      const tick = () => {
        el.scrollTop += step
        left -= 1
        if (left > 0) requestAnimationFrame(tick)
        else void afterPaint().then(() => resolve({ top: el.scrollTop, height: el.scrollHeight }))
      }
      requestAnimationFrame(tick)
    })
  },
  /** Class and tail of the last document block, for diagnosing a wait that never ends. */
  lastBlock() {
    const blocks = all('.doc-block')
    const last = blocks[blocks.length - 1]
    return last ? { n: blocks.length, caret: !!last.querySelector('.caret'), tail: last.textContent.slice(-80) } : null
  },
  react: () => contextBridge.executeInMainWorld({ func: () => window.__benchReact?.take() ?? null }),
  reactStart: () => contextBridge.executeInMainWorld({ func: () => window.__benchReact?.start() ?? null }),
}
contextBridge.exposeInMainWorld('__bench', api)

// ---- React commits and component renders (counts runs only) ----
// The counter is the walk from T3 Code's render counter (apps/web/test/renderCounter.ts) at
// commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
// React reports commits only to a DevTools hook that exists before react-dom loads, so this
// runs in the page's own world at document start.
function installReactCounter() {
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])
  const state = { on: false, commits: 0, renders: 0, counts: new Map() }
  const nameOf = (fiber) => {
    const type = fiber.type
    if (!type || (typeof type !== 'object' && typeof type !== 'function')) return null
    const inner = type.type ?? type.render ?? type
    return type.displayName || inner.displayName || inner.name || 'Anonymous'
  }
  // Bailed-out subtrees (child === alternate.child) keep stale flags and are skipped.
  const visit = (fiber) => {
    let rendered = 0
    for (let node = fiber; node; node = node.sibling) {
      const performed = COMPONENT_TAGS.has(node.tag) && (node.flags & 1) === 1
      const name = performed ? nameOf(node) : null
      if (name) {
        state.counts.set(name, (state.counts.get(name) ?? 0) + 1)
        rendered += 1
      }
      const skipped = node.alternate !== null && node.child === node.alternate.child && !performed
      if (node.child && !skipped) rendered += visit(node.child)
    }
    return rendered
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: (_id, root) => {
      if (!state.on) return
      // A commit that did no work (an update left behind by a component that has since
      // unmounted) hands back the same tree, still flagged by the commit that rendered it.
      const host = root.current
      if (host.alternate !== null && host.child === host.alternate.child) return
      const rendered = visit(host.child)
      if (rendered > 0) state.commits += 1
      state.renders += rendered
    },
  }
  window.__benchReact = {
    start() {
      Object.assign(state, { on: true, commits: 0, renders: 0, counts: new Map() })
      return true
    },
    take() {
      state.on = false
      const top = [...state.counts].sort((a, b) => b[1] - a[1]).slice(0, 12)
      return { commits: state.commits, renders: state.renders, top: Object.fromEntries(top) }
    },
  }
}
if (process.env.BENCH_REACT === '1') contextBridge.executeInMainWorld({ func: installReactCounter })
