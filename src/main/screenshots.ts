import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import type { Block, SnapshotDiff } from '../shared/contracts'
import type { ProviderSessionManager } from './ProviderSessionManager'

type Point = { x: number; y: number }

/** The window size the shots are taken at, whatever the display's work area. */
export const SCREENSHOT_SIZE = { width: 1280, height: 840 } as const

/**
 * `HIDEGPT_SCREENSHOT=<dir>` (with `HIDEGPT_FAKE=1`): walks Home and its
 * menus, the folder picker, a new document, a document (across a page break,
 * streaming, and with a pending suggestion), every toolbar and header menu,
 * the narrow layouts, and the library switch, saving a PNG of each plus the
 * fonts that loaded, then returns. A smoke test of the real app.
 */
export const captureScreenshots = (
  win: BrowserWindow,
  manager: ProviderSessionManager['Service'],
  /** Sends a screenshot-only patch through the publisher, so it gets a real `seq`. */
  stage: (diff: SnapshotDiff) => void,
  dir: string,
) =>
  Effect.gen(function* () {
    mkdirSync(dir, { recursive: true })
    const js = <A = unknown>(script: string) =>
      Effect.promise(() => win.webContents.executeJavaScript(script) as Promise<A>)
    const pause = (ms = 150) => Effect.sleep(`${ms} millis`)
    const shot = (name: string) =>
      Effect.gen(function* () {
        yield* pause()
        win.webContents.invalidate()
        yield* js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
        const image = yield* Effect.promise(() => win.capturePage())
        writeFileSync(join(dir, `${name}.png`), image.toPNG())
      })
    const waitUntil = (condition: string, what: string) =>
      js(`new Promise((resolve, reject) => {
        const started = Date.now()
        const check = () => {
          if (${condition}) resolve(true)
          else if (Date.now() - started > 8000) reject(new Error(${JSON.stringify(`${what} did not happen`)}))
          else setTimeout(check, 50)
        }
        check()
      })`)
    const waitFor = (selector: string, what: string) =>
      waitUntil(`document.querySelector(${JSON.stringify(selector)})`, `${what} appearing`)
    const centreOf = (selector: string) =>
      js<Point>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) throw new Error(${JSON.stringify(`missing ${selector}`)})
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
    const byTestId = (testId: string) => `[data-testid="${testId}"]`
    // Real mouse input, so menus and focus behave as they do for a person.
    const clickAt = ({ x, y }: Point) =>
      Effect.gen(function* () {
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        yield* pause(200)
      })
    const click = (testId: string) => Effect.flatMap(centreOf(byTestId(testId)), clickAt)
    // Menus close on a click in empty canvas at the window's left edge.
    const dismiss = () => clickAt({ x: 6, y: 520 })
    // Park the pointer there so a button that swapped in under it doesn't show hover.
    const rest = () =>
      Effect.gen(function* () {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 6, y: 520 })
        yield* pause(150)
      })
    const hover = (testId: string) =>
      Effect.gen(function* () {
        const { x, y } = yield* centreOf(byTestId(testId))
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        yield* pause(300)
      })

    yield* manager.snapshots.pipe(
      Stream.filter((snapshot) => snapshot.status !== 'connecting'),
      Stream.runHead,
    )
    // An occluded window stops painting and capturePage returns stale frames.
    win.webContents.setBackgroundThrottling(false)
    win.setAlwaysOnTop(true)
    win.show()
    yield* waitFor('[data-testid="app"]', 'The app')

    // Fonts are bundled; record what actually loaded so reviews can verify it.
    const fonts = yield* js(`document.fonts.ready.then(() => ({
      loaded: Array.from(document.fonts).filter((face) => face.status === 'loaded').map((face) => face.family + ' ' + face.weight),
      ui: getComputedStyle(document.body).fontFamily,
      googleSansFlex: document.fonts.check('14px "Google Sans Flex Variable"'),
      roboto: document.fonts.check('12px Roboto'),
    }))`)
    writeFileSync(join(dir, 'fonts.json'), JSON.stringify(fonts, null, 2))

    yield* shot('home')
    yield* click('home-location')
    yield* shot('home-location-menu')
    yield* dismiss()
    yield* click('open-picker')
    yield* shot('folder-picker')
    yield* click('new-folder')
    yield* shot('folder-new')
    yield* js(`document.querySelector('[data-slot="dialog-popup"] .text-button').click()`)
    yield* pause()
    yield* js(`document.querySelector('[data-slot="dialog-close"]')?.click()`)
    yield* pause()
    yield* click('menu-account')
    yield* shot('account-menu')
    yield* dismiss()
    yield* Effect.flatMap(centreOf('[aria-label="List view"]'), clickAt)
    yield* rest()
    yield* shot('home-list')
    yield* js(`document.querySelector('[aria-label="Grid view"]').click()`)

    // The document from before the walk: a just-created one would be empty.
    const before = yield* manager.snapshot

    // Blank document creates immediately, like Docs, and focuses the page.
    yield* click('new-doc')
    yield* waitUntil(
      `document.querySelector('[data-testid="composer"]') && document.activeElement === document.querySelector('[data-testid="composer"]')`,
      'The new document focusing its composer',
    )
    yield* shot('new-document-ready')

    yield* Option.match(Option.fromNullishOr(before.threads[0]), {
      onNone: () => manager.dispatch({ op: 'newDocument' }),
      onSome: (doc) => manager.dispatch({ op: 'openThread', threadId: doc.id }),
    })
    yield* waitFor('[data-testid="document"] .doc-block', 'The document')
    yield* shot('document')

    // Print layout across a page break. The fake thread fits on one page, so
    // copies of its blocks (screenshot-only, removed after) make it run long.
    yield* js(`(() => {
      const flow = document.querySelector('.paper-flow')
      const composer = flow.querySelector('.composer-wrap')
      for (const block of Array.from(flow.querySelectorAll('.doc-block'))) {
        const copy = block.cloneNode(true)
        copy.dataset.screenshotCopy = ''
        flow.insertBefore(copy, composer)
      }
      return true
    })()`)
    yield* pause(400)
    yield* js(`(() => {
      const workspace = document.querySelector('[data-testid="document"]')
      const second = document.querySelectorAll('.page-sheet')[1]
      if (workspace && second) workspace.scrollTop += second.getBoundingClientRect().top - workspace.getBoundingClientRect().top - 360
      return true
    })()`)
    yield* shot('document-page-break')
    yield* js(`(() => {
      document.querySelectorAll('[data-screenshot-copy]').forEach((node) => node.remove())
      document.querySelector('[data-testid="document"]').scrollTop = 0
      return true
    })()`)
    yield* pause(300)

    // States the fake session never reaches: a reply streaming in (with a code
    // block), then a pending suggestion. They are screenshot-only snapshot
    // patches on top of the real blocks, and the real blocks come back after.
    const real = (yield* manager.snapshot).blocks.length
    const showBlocks = (blocks: Block[], streaming: boolean) =>
      stage({
        fields: { streaming },
        blocks: { length: real + blocks.length, set: blocks.map((block, index) => [real + index, block] as const) },
      })
    const question: Block = { kind: 'user', id: 'shot-question', text: 'How would we check the worked examples?' }
    const reply: Block = {
      kind: 'agent',
      id: 'shot-reply',
      text: 'Run each example as a short script and compare its output with the expected value:\n\n```\nfor example in examples/*.txt; do\n  check-example "$example" --expect "${example%.txt}.out"\ndone\n```\n\nIf an example',
    }
    const suggestion: Block = {
      kind: 'approval',
      id: 'shot-approval',
      suggestion: 'add',
      title: 'Run command?',
      body: 'check-example examples/week-3.txt',
      fields: [],
      questions: [],
      resolved: null,
    }
    const scrollToQuestion = () =>
      js(`(() => {
        const workspace = document.querySelector('[data-testid="document"]')
        const question = Array.from(document.querySelectorAll('.doc-question')).pop()
        if (workspace && question) workspace.scrollTop += question.getBoundingClientRect().top - workspace.getBoundingClientRect().top - 120
        return true
      })()`)
    showBlocks([question, reply], true)
    yield* pause(400)
    yield* scrollToQuestion()
    yield* shot('document-streaming')
    showBlocks([question, { ...reply, text: reply.text.replace(/\n\nIf an example$/, '') }, suggestion], true)
    yield* pause(400)
    yield* scrollToQuestion()
    yield* shot('document-suggestion')
    stage({ fields: { streaming: false }, blocks: { length: real } })
    yield* pause(300)
    yield* js(`(() => {
      document.querySelector('[data-testid="document"]').scrollTop = 0
      return true
    })()`)
    yield* pause(300)

    // Docs' own dark hover label, not the system tooltip.
    yield* hover('chip-model')
    yield* pause(900)
    yield* shot('tooltip')
    yield* rest()
    const menus = [
      ['menu-file', 'menu-file'],
      ['menu-view', 'menu-view'],
      ['chip-zoom', 'menu-zoom'],
      ['chip-model', 'menu-style'],
      ['chip-effort', 'menu-font'],
      ['chip-speed', 'menu-size'],
      ['chip-mode', 'menu-mode'],
      ['toolbar-more', 'toolbar-more'],
      ['share', 'share-dialog'],
      ['share-menu', 'menu-share'],
      ['menu-account', 'account-menu-doc'],
    ] as const
    for (const [trigger, name] of menus) {
      yield* click(trigger)
      // Font-menu faces load the first time a row shows them.
      if (trigger === 'chip-effort') yield* js('document.fonts.ready.then(() => true)')
      yield* shot(name)
      if (trigger === 'menu-file') {
        yield* hover('action-new')
        yield* shot('menu-file-new')
      }
      if (trigger === 'chip-model') {
        const firstModel = (yield* manager.snapshot).models[0]
        if (firstModel) {
          yield* hover(`pick-${firstModel.id}`)
          yield* pause(600)
          yield* shot('menu-style-cascade')
        }
        yield* click('pick-options')
        yield* shot('menu-style-options')
      }
      yield* dismiss()
    }

    win.setSize(760, 700)
    yield* shot('document-narrow')
    yield* click('toolbar-more')
    yield* shot('toolbar-more-narrow')
    yield* dismiss()
    yield* manager.dispatch({ op: 'goHome' })
    yield* shot('home-narrow')
    win.setSize(SCREENSHOT_SIZE.width, SCREENSHOT_SIZE.height)

    // Switching "accounts" swaps the document library.
    yield* click('menu-account')
    yield* click('library-opencode')
    yield* waitFor('[data-testid="docs-home"]', 'The OpenCode home')
    yield* waitUntil(`!document.querySelector('.top-progress')`, 'The library switch finishing')
    yield* shot('opencode-home')
    yield* click('menu-account')
    yield* shot('account-menu-opencode')
    yield* click('library-codex')
    yield* pause(300)
    const returnedHome = yield* js<boolean>(`!!document.querySelector('.route-home .home')`)
    if (!returnedHome) return yield* Effect.die(new Error('Switching back to Codex did not return to its library'))
  })
