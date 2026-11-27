import * as Effect from 'effect/Effect'

import type { Block, SnapshotDiff } from '../../shared/contracts'
import type { ProviderSessionManager } from '../ProviderSessionManager'
import { finishedReply, question, referenceDocument, reply, suggestion } from './content'
import type { Driver } from './driver'

/** The reference widths: Docs' own captures are 1402 (scaled to 1280) and 1470 at 2x. */
export const CORE_SIZES = [
  [1280, 800],
  [1402, 877],
  [1470, 923],
  [1680, 1050],
  [1920, 1080],
  [760, 700],
] as const

/** Shared navigation for the phases. */
export const makeNav = (d: Driver, manager: ProviderSessionManager['Service'], stage: (diff: SnapshotDiff) => void) =>
  Effect.gen(function* () {
    const demo = (yield* manager.snapshot).threads[0]
    if (!demo) return yield* Effect.die(new Error('The demo library has no documents'))
    const goHome = () =>
      Effect.gen(function* () {
        yield* manager.dispatch({ op: 'goHome' })
        yield* d.waitFor('[data-testid="docs-home"]', 'Home')
        yield* d.pause(250)
      })
    const open = (threadId: string, ready: string) =>
      Effect.gen(function* () {
        yield* manager.dispatch({ op: 'openThread', threadId })
        yield* d.waitFor(ready, 'The document')
        yield* d.pause(400)
      })
    const openDemo = () => open(demo.id, '[data-testid="document"] .doc-block')
    // One blank document for the whole phase, made before the first shot, so
    // Home lists the same documents at every width.
    yield* manager.dispatch({ op: 'newDocument' })
    const route = (yield* manager.snapshot).route
    if (route.kind !== 'doc') return yield* Effect.die(new Error('New document did not open'))
    const blank = route.threadId
    yield* goHome()
    const openBlank = () => open(blank, '[data-testid="composer"]')

    const gridView = () => d.js(`document.querySelector('[aria-label="Grid view"]')?.click()`)
    const scrollTop = () =>
      d.js(
        `(() => { const w = document.querySelector('[data-testid="document"]'); if (w) w.scrollTop = 0; return true })()`,
      )
    const scrollBottom = () =>
      d.js(
        `(() => { const w = document.querySelector('[data-testid="document"]'); w.scrollTop = w.scrollHeight; return true })()`,
      )
    const scrollToQuestion = () =>
      d.js(`(() => {
        const workspace = document.querySelector('[data-testid="document"]')
        const question = Array.from(document.querySelectorAll('.doc-question')).pop()
        if (workspace && question) workspace.scrollTop += question.getBoundingClientRect().top - workspace.getBoundingClientRect().top - 120
        return true
      })()`)
    /**
     * Shows a screenshot-only diff and returns its undo: the fields it touched
     * and the block count go back to the real state. Main never saw the diff,
     * so later real patches would not undo it themselves.
     */
    const show = (diff: SnapshotDiff) =>
      Effect.sync(() => {
        stage(diff)
        return Effect.gen(function* () {
          const real = yield* manager.snapshot
          const fields = Object.fromEntries(
            Object.keys(diff.fields).map((key) => [key, real[key as keyof typeof real]]),
          )
          stage({ fields, blocks: { length: real.blocks.length } })
          yield* d.pause(250)
        })
      })
    /**
     * Screenshot-only blocks after the document's own. After a stream the undo
     * also reopens the document: a finished stream flashes "Saved to Drive" for
     * 4s, and a shot taken near that edge would differ from run to run.
     */
    const withBlocks = (blocks: ReadonlyArray<Block>, streaming: boolean) =>
      Effect.gen(function* () {
        const real = (yield* manager.snapshot).blocks.length
        const undo = yield* show({
          fields: { streaming },
          blocks: { length: real + blocks.length, set: blocks.map((block, index) => [real + index, block] as const) },
        })
        return Effect.gen(function* () {
          yield* undo
          if (streaming) {
            yield* goHome()
            yield* openDemo()
          }
          yield* scrollTop()
        })
      })
    /** The blank document showing the reference content, unfocused; returns its undo. */
    const openReference = () =>
      Effect.gen(function* () {
        yield* openBlank()
        const undo = yield* show(referenceDocument)
        yield* d.waitFor('.doc-body li', 'The reference content')
        yield* d.pause(500)
        yield* d.blur()
        yield* d.rest()
        return undo
      })
    return {
      demo,
      goHome,
      gridView,
      openDemo,
      openBlank,
      scrollTop,
      scrollBottom,
      scrollToQuestion,
      show,
      withBlocks,
      openReference,
    }
  })

export type Nav = Effect.Success<ReturnType<typeof makeNav>>

/**
 * `core`: the screens every fidelity metric reads, at each reference width.
 * Home (grid and list), an empty document, the reference document, the demo
 * document, a streaming reply, a pending suggestion at 100% and 125%, and the
 * error banner.
 */
export const core = (d: Driver, nav: Nav, manager: ProviderSessionManager['Service']) =>
  Effect.gen(function* () {
    for (const [width, height] of CORE_SIZES) {
      yield* d.step(
        `core-${width}`,
        Effect.gen(function* () {
          yield* d.setViewport(width, height)
          yield* nav.goHome()
          yield* nav.gridView()
          yield* d.rest()
          yield* d.shot('home')
          yield* d.clickSel('[aria-label="List view"]')
          yield* d.rest()
          yield* d.shot('home-list')
          yield* nav.gridView()

          yield* nav.openBlank()
          yield* d.shot('document-empty')
          const undoReference = yield* nav.openReference()
          yield* d.shot('document-ref')
          yield* undoReference

          yield* nav.goHome()
          yield* nav.openDemo()
          yield* d.blur()
          yield* d.rest()
          yield* d.shot('document')

          const restoreStreaming = yield* nav.withBlocks([question, reply], true)
          yield* d.pause(400)
          yield* nav.scrollToQuestion()
          yield* d.shot('document-streaming')
          yield* restoreStreaming
          const restore = yield* nav.withBlocks([question, finishedReply, suggestion], true)
          yield* d.pause(400)
          yield* nav.scrollToQuestion()
          yield* d.shot('document-suggestion')
          // Page zoom scales the paper; a suggestion card should not scale with it.
          yield* d.step(
            `core-${width}-zoom125`,
            Effect.gen(function* () {
              yield* d.click('chip-zoom')
              yield* d.clickSel('[data-testid="zoom-125"]')
              yield* d.pause(400)
              yield* nav.scrollToQuestion()
              yield* d.rest()
              yield* d.shot('document-suggestion-125')
              yield* d.click('chip-zoom')
              yield* d.clickSel('[data-testid="zoom-100"]')
              yield* d.pause(300)
            }),
          )
          yield* restore

          // A dismissed error stays hidden for the session, so each width shows its own.
          yield* manager.notify(`Docs couldn’t save your last change (${width}).`)
          yield* d.waitFor('[data-testid="error-banner"]', 'The error banner')
          yield* d.rest()
          yield* d.shot('document-error')
          yield* d.click('error-dismiss')
          yield* d.pause(200)
        }),
      )
    }
  })
