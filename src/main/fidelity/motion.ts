import * as Effect from 'effect/Effect'

import type { Nav } from './core'
import type { Driver } from './driver'

/** Records layout shifts (and, with `samples`, the last block's growth per frame) into `window[name]`. */
const observe = (name: string, samples: boolean) => `(() => {
  const log = { shifts: [], samples: [], t0: performance.now() }
  window[${JSON.stringify(name)}] = log
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) log.shifts.push({ t: Math.round(e.startTime - log.t0), v: e.value })
  }).observe({ type: 'layout-shift', buffered: false })
  if (${samples}) {
    const tick = () => {
      const last = Array.from(document.querySelectorAll('.doc-block')).pop()
      const w = document.querySelector('[data-testid="document"]')
      log.samples.push({ t: Math.round(performance.now() - log.t0), chars: last ? last.textContent.length : 0, top: w ? Math.round(w.scrollTop) : 0, h: w ? w.scrollHeight : 0 })
      if (performance.now() - log.t0 < 9000) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  return true
})()`

/**
 * `motion`: a real fake-provider answer streaming in, captured frame by frame
 * with a layout-shift log, then the frames right after a Home card opens a
 * document. Timing-dependent by nature, so two runs are not pixel-identical.
 */
export const motion = (d: Driver, nav: Nav) =>
  Effect.gen(function* () {
    yield* d.setViewport(1402, 877)
    yield* nav.openDemo()
    yield* d.clickSel('[data-testid="composer"]')
    yield* d.typeText('What makes a good summary?')
    yield* d.pause(200)
    yield* d.shot('m-000-typed')
    yield* d.js(observe('__stream', true))
    yield* d.key('Enter', 'Enter', 13)
    for (let i = 1; i <= 24; i++) {
      yield* d.pause(i <= 10 ? 60 : 250)
      yield* d.frame(`m-${String(i).padStart(3, '0')}`)
    }
    yield* d.pause(3500)
    yield* d.shot('m-999-done')
    yield* d.writeJson('stream-log', yield* d.js('window.__stream'))

    yield* nav.goHome()
    yield* d.js(observe('__open', false))
    const card = yield* d.centreOf('.doc-card')
    yield* d.move(card)
    yield* d.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...card, button: 'left', clickCount: 1 })
    yield* d.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...card, button: 'left', clickCount: 1 })
    for (let i = 0; i < 10; i++) {
      yield* d.frame(`open-${String(i).padStart(2, '0')}`)
      yield* d.pause(30)
    }
    yield* d.pause(800)
    yield* d.shot('open-99-done')
    yield* d.writeJson('open-log', yield* d.js('window.__open'))
  })
