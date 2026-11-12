import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'

import { clockScript } from './clock'

type Point = { x: number; y: number }

/** CSS selector -> the computed properties `pnpm fidelity:check` reads from it (`targets.json`). */
export type Probes = Readonly<Record<string, ReadonlyArray<string>>>

/** What a phase leaves in `<root>/manifest.json`; `pnpm fidelity:shots` reads it to pass or fail the run. */
type Manifest = {
  phase: string
  shots: Array<{ viewport: string; name: string }>
  failures: Array<{ step: string; error: string }>
  ms: number
}

/**
 * Every visible element: its box plus the styles a fidelity review compares, and
 * the `probes` the metric gate asks for, read the way the page renders them
 * (as T3 Code's apps/web/src/appearanceFonts.browser.test.ts reads computed styles).
 */
const dumpScript = (probes: Probes) => `(() => {
  const vw = innerWidth, vh = innerHeight
  const visible = (r) => r.width > 0 && r.height > 0 && r.bottom >= 0 && r.top <= vh && r.right >= 0 && r.left <= vw
  const box = (r) => ({ x: +r.left.toFixed(2), y: +r.top.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) })
  const nodes = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (!visible(r)) continue
    const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || ''
    const s = getComputedStyle(el)
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim()
    nodes.push({
      tag: el.tagName.toLowerCase(), cls, tid: el.getAttribute('data-testid') || '', aria: el.getAttribute('aria-label') || '',
      ...box(r), text: own.slice(0, 60),
      ff: s.fontFamily, fs: s.fontSize, fw: s.fontWeight, lh: s.lineHeight, ls: s.letterSpacing, fvs: s.fontVariationSettings,
      smooth: s.webkitFontSmoothing, color: s.color, bg: s.backgroundColor, radius: s.borderRadius,
      border: s.borderTopWidth + ' ' + s.borderTopStyle + ' ' + s.borderTopColor,
      pad: s.padding, mar: s.margin, shadow: s.boxShadow,
    })
  }
  const probes = {}
  for (const [selector, props] of Object.entries(${JSON.stringify(probes)})) {
    const el = Array.from(document.querySelectorAll(selector)).find((e) => visible(e.getBoundingClientRect()))
    if (!el) { probes[selector] = null; continue }
    const s = getComputedStyle(el)
    probes[selector] = { ...box(el.getBoundingClientRect()), style: Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)])) }
  }
  return { vw, vh, dpr: devicePixelRatio, nodes, probes }
})()`

/** Marks one element per distinct font setting, so CDP can ask which faces Chromium drew it with. */
const markFonts = `(() => {
  const seen = new Map()
  for (const el of document.querySelectorAll('body *')) {
    if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const s = getComputedStyle(el)
    const key = [s.fontFamily, s.fontSize, s.fontWeight, s.fontStyle, s.fontVariationSettings].join('|')
    if (!seen.has(key)) seen.set(key, el)
  }
  return Array.from(seen.values()).map((el, i) => {
    el.setAttribute('data-fidelity-font', String(i))
    const s = getComputedStyle(el)
    return { tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 40), ff: s.fontFamily, fs: s.fontSize, fw: s.fontWeight, fvs: s.fontVariationSettings }
  })
})()`

/**
 * Settles the page the way Playwright's screenshot options do (`animations:
 * 'disabled'`): fonts loaded, finite animations and transitions at their end,
 * infinite ones stopped at their first frame. It then repaints the whole
 * view (a one-frame root background change), so every shot is rastered from a
 * full invalidation; partial repaints left 1-6 levels of antialiasing noise on
 * a few icons from run to run.
 */
const settleScript = `document.fonts.ready.then(async () => {
  for (const animation of document.getAnimations()) {
    const timing = animation.effect && animation.effect.getComputedTiming()
    if (timing && timing.endTime === Infinity) { animation.pause(); animation.currentTime = 0 }
    else animation.finish()
  }
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
  const root = document.documentElement.style
  const background = root.backgroundColor
  root.backgroundColor = 'rgb(1, 2, 3)'
  await frame()
  root.backgroundColor = background
  await frame()
  await frame()
  return true
})`

/** Hides the blinking text caret, as Playwright's `caret: 'hide'` does; the streaming cursor is CSS and stays. */
const captureStyle = `(() => {
  const style = document.createElement('style')
  style.textContent = '* { caret-color: transparent !important; }'
  document.head.append(style)
  return true
})()`

/**
 * Drives a window that is never shown through the DevTools protocol: device
 * metrics at scale 2, real mouse and key input, PNG capture, layout dumps.
 */
export const makeDriver = (win: BrowserWindow, root: string, phase: string, probes: Probes) =>
  Effect.gen(function* () {
    const started = Date.now()
    const manifest: Manifest = { phase, shots: [], failures: [], ms: 0 }
    mkdirSync(root, { recursive: true })
    const dbg = win.webContents.debugger
    dbg.attach('1.3')

    const cdp = <A = unknown>(method: string, params: Record<string, unknown> = {}) =>
      Effect.promise(() => {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 15_000)
        })
        return Promise.race([dbg.sendCommand(method, params) as Promise<A>, timeout]).finally(() => clearTimeout(timer))
      })
    const js = <A = unknown>(script: string) =>
      Effect.promise(() => win.webContents.executeJavaScript(script) as Promise<A>)
    const pause = (ms = 150) => Effect.sleep(`${ms} millis`)

    const waitUntil = (condition: string, what: string) =>
      js(`new Promise((resolve, reject) => {
        const started = performance.now()
        const check = () => {
          if (${condition}) resolve(true)
          else if (performance.now() - started > 8000) reject(new Error(${JSON.stringify(`${what} did not happen`)}))
          else setTimeout(check, 50)
        }
        check()
      })`)
    const waitFor = (selector: string, what: string) =>
      waitUntil(`document.querySelector(${JSON.stringify(selector)})`, `${what} appearing`)

    let dir = root
    let view = { width: 1280, height: 800 }
    let label = ''
    const emulate = (width: number, height: number) =>
      Effect.gen(function* () {
        view = { width, height }
        yield* cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
        yield* pause(350)
      })
    /** Sizes the page and sends the next shots to `<root>/<width>/`. */
    const setViewport = (width: number, height: number) =>
      Effect.gen(function* () {
        label = String(width)
        dir = join(root, label)
        mkdirSync(dir, { recursive: true })
        yield* emulate(width, height)
      })

    // Before the first shot: a pinned clock, time zone, locale and colour scheme
    // (as T3 Code's preview manager pins media over its CDP session), then a reload
    // so the page starts on the pinned clock.
    yield* cdp('Page.enable')
    yield* cdp('DOM.enable')
    yield* cdp('CSS.enable')
    yield* cdp('Page.addScriptToEvaluateOnNewDocument', { source: clockScript() })
    yield* cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    yield* cdp('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
    yield* cdp('Emulation.setLocaleOverride', { locale: 'en-US' })
    yield* cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    yield* emulate(1402, 877)
    yield* cdp('Page.reload', { ignoreCache: true })
    yield* pause(300)
    yield* waitFor('[data-testid="app"]', 'The app')
    yield* js(captureStyle)
    yield* js('document.fonts.ready.then(() => true)')

    const capture = (file: string) =>
      Effect.gen(function* () {
        const { data } = yield* cdp<{ data: string }>('Page.captureScreenshot', { format: 'png' })
        writeFileSync(file, Buffer.from(data, 'base64'))
      })
    const fonts = Effect.gen(function* () {
      const rows = yield* js<Array<Record<string, string>>>(markFonts)
      const { root: doc } = yield* cdp<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
      const used = []
      for (const [index, row] of rows.entries()) {
        const { nodeId } = yield* cdp<{ nodeId: number }>('DOM.querySelector', {
          nodeId: doc.nodeId,
          selector: `[data-fidelity-font="${index}"]`,
        })
        const platform = nodeId
          ? (yield* cdp<{ fonts: unknown[] }>('CSS.getPlatformFontsForNode', { nodeId })).fonts
          : []
        used.push({ ...row, platform })
      }
      yield* js(
        `document.querySelectorAll('[data-fidelity-font]').forEach((el) => el.removeAttribute('data-fidelity-font'))`,
      )
      return used
    })
    /** A settled PNG plus its layout dump (boxes, styles, probes, the platform fonts drawn). */
    const shot = (name: string) =>
      Effect.gen(function* () {
        yield* pause()
        yield* js(settleScript)
        yield* capture(join(dir, `${name}.png`))
        const layout = yield* js<Record<string, unknown>>(dumpScript(probes))
        writeFileSync(join(dir, `${name}.json`), JSON.stringify({ ...layout, fonts: yield* fonts }))
        manifest.shots.push({ viewport: label, name })
      })
    /** An unsettled frame, for motion: no dump, animations left running. */
    const frame = (name: string) => capture(join(dir, `${name}.png`))
    const writeJson = (name: string, data: unknown) =>
      Effect.sync(() => writeFileSync(join(dir, `${name}.json`), JSON.stringify(data)))

    const centreOf = (selector: string) =>
      js<Point>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) throw new Error(${JSON.stringify(`missing ${selector}`)})
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
    const tid = (testId: string) => `[data-testid="${testId}"]`
    const move = ({ x, y }: Point) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    // Real mouse input, so menus and focus behave as they do for a person.
    const clickAt = ({ x, y }: Point, button: 'left' | 'right' = 'left') =>
      Effect.gen(function* () {
        yield* move({ x, y })
        yield* cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
        yield* cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
        yield* pause(250)
      })
    const clickSel = (selector: string, button: 'left' | 'right' = 'left') =>
      Effect.flatMap(centreOf(selector), (p) => clickAt(p, button))
    const click = (testId: string) => clickSel(tid(testId))
    const hoverSel = (selector: string, wait = 350) =>
      Effect.gen(function* () {
        yield* move(yield* centreOf(selector))
        yield* pause(wait)
      })
    // Empty canvas at the left edge: a click there closes menus, and the pointer
    // parked there leaves no hover on a button that swapped in under it.
    const restPoint = () => ({ x: 6, y: Math.min(520, view.height - 40) })
    const dismiss = () => clickAt(restPoint())
    const rest = () =>
      Effect.gen(function* () {
        yield* move(restPoint())
        yield* pause(150)
      })
    const key = (k: string, code: string, keyCode: number, modifiers = 0) =>
      Effect.gen(function* () {
        yield* cdp('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: k,
          code,
          windowsVirtualKeyCode: keyCode,
          modifiers,
        })
        yield* cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode, modifiers })
        yield* pause(120)
      })
    const tab = () => key('Tab', 'Tab', 9)
    const escape = () => key('Escape', 'Escape', 27)
    const typeText = (text: string) => cdp('Input.insertText', { text })
    const blur = () => js('document.activeElement && document.activeElement.blur()')

    /** Runs one step; a failure is logged and recorded, and the phase carries on. */
    const step = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = String(cause).slice(0, 400)
            console.error(`step failed: ${name}: ${error}`)
            manifest.failures.push({ step: name, error })
          }),
        ),
      )
    const finish = () =>
      Effect.sync(() => {
        manifest.ms = Date.now() - started
        writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2))
        dbg.detach()
      })

    return {
      cdp,
      js,
      pause,
      waitUntil,
      waitFor,
      setViewport,
      emulate,
      shot,
      frame,
      writeJson,
      centreOf,
      tid,
      move,
      clickAt,
      clickSel,
      click,
      hoverSel,
      dismiss,
      rest,
      key,
      tab,
      escape,
      typeText,
      blur,
      step,
      finish,
    }
  })

export type Driver = Effect.Success<ReturnType<typeof makeDriver>>
