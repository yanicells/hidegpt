import * as Effect from 'effect/Effect'

import type { ProviderSessionManager } from '../ProviderSessionManager'
import { callout, formatSuggestion, question, questionSuggestion } from './content'
import type { Nav } from './core'
import type { Driver } from './driver'

const MENUBAR = ['file', 'edit', 'view', 'insert', 'format', 'tools', 'gemini', 'extensions', 'help'] as const
const CHIP_MENUS = [
  ['chip-zoom', 'menu-zoom'],
  ['chip-model', 'menu-style'],
  ['chip-effort', 'menu-font'],
  ['chip-speed', 'menu-size'],
  ['chip-mode', 'menu-mode'],
  ['toolbar-more', 'toolbar-more'],
  ['share-menu', 'menu-share'],
  ['menu-account', 'account-menu-doc'],
] as const

/** Clears a React-controlled field the way typing would. */
const clearField = (selector: string, proto: 'HTMLInputElement' | 'HTMLTextAreaElement') => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  Object.getOwnPropertyDescriptor(${proto}.prototype, 'value').set.call(el, '')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.blur()
  return true
})()`

/**
 * `states`: hover, focus, menus, dialogs, banners and narrow widths at the
 * 1402 reference viewport (the 1280-wide Docs references), each step on its own
 * so one missing control does not end the phase.
 */
export const states = (d: Driver, nav: Nav, manager: ProviderSessionManager['Service']) =>
  Effect.gen(function* () {
    yield* d.setViewport(1402, 877)
    yield* nav.goHome()
    yield* nav.gridView()

    // Home.
    yield* d.step(
      'home-hover',
      Effect.gen(function* () {
        yield* d.hoverSel('.doc-card')
        yield* d.shot('home-hover-card')
        yield* d.hoverSel('.template-strip > *:nth-child(2)')
        yield* d.shot('home-hover-template')
        yield* d.rest()
      }),
    )
    yield* d.step(
      'home-search',
      Effect.gen(function* () {
        yield* d.click('home-search')
        yield* d.shot('home-search-focus')
        yield* d.typeText('week')
        yield* d.pause(300)
        yield* d.shot('home-search-typed')
        yield* d.typeText('zzzz')
        yield* d.pause(300)
        yield* d.shot('home-search-empty')
        yield* d.js(clearField('[data-testid="home-search"]', 'HTMLInputElement'))
        yield* d.pause(200)
      }),
    )
    yield* d.step(
      'home-focus',
      Effect.gen(function* () {
        yield* d.rest()
        for (let i = 0; i < 3; i++) yield* d.tab()
        yield* d.shot('home-focus-tab3')
        for (let i = 0; i < 6; i++) yield* d.tab()
        yield* d.shot('home-focus-tab9')
        yield* d.blur()
      }),
    )
    // Docs opens a context menu here; the shot shows what HideGPT does instead.
    yield* d.step(
      'home-context',
      Effect.gen(function* () {
        yield* d.clickSel('.doc-card', 'right')
        yield* d.pause(300)
        yield* d.shot('home-context-card')
        yield* d.escape()
        yield* d.dismiss()
      }),
    )
    yield* d.step(
      'home-card-more',
      Effect.gen(function* () {
        yield* d.clickSel('.doc-card .card-more')
        yield* d.pause(300)
        yield* d.shot('home-card-more')
      }),
    )
    // That click may open the document.
    yield* nav.goHome()
    yield* d.step(
      'home-location',
      Effect.gen(function* () {
        yield* d.click('home-location')
        yield* d.shot('home-location-menu')
        yield* d.dismiss()
      }),
    )
    yield* d.step(
      'home-sort',
      Effect.gen(function* () {
        yield* d.clickSel('[aria-label="Sort by title"]')
        yield* d.shot('home-sort')
        yield* d.dismiss()
        yield* d.escape()
      }),
    )
    yield* d.step(
      'home-tooltip',
      Effect.gen(function* () {
        yield* d.hoverSel('[aria-label="List view"]', 1200)
        yield* d.shot('home-tooltip')
        yield* d.rest()
      }),
    )
    yield* d.step(
      'folder-picker',
      Effect.gen(function* () {
        yield* d.click('open-picker')
        yield* d.shot('folder-picker')
        yield* d.click('new-folder')
        yield* d.shot('folder-new')
        yield* d.js(`document.querySelector('[data-slot="dialog-popup"] .text-button')?.click()`)
        yield* d.pause()
        yield* d.js(`document.querySelector('[data-slot="dialog-close"]')?.click()`)
        yield* d.pause()
        yield* d.escape()
      }),
    )
    yield* d.step(
      'account-home',
      Effect.gen(function* () {
        yield* d.click('menu-account')
        yield* d.shot('account-menu')
        yield* d.hoverSel('[data-testid="library-opencode"]')
        yield* d.shot('account-menu-hover')
        yield* d.dismiss()
        yield* d.escape()
      }),
    )
    yield* d.step(
      'home-list',
      Effect.gen(function* () {
        yield* d.clickSel('[aria-label="List view"]')
        yield* d.hoverSel('.list-row')
        yield* d.shot('home-list-hover')
        yield* d.rest()
        yield* nav.gridView()
      }),
    )

    // Document.
    yield* nav.openDemo()
    yield* d.step(
      'composer',
      Effect.gen(function* () {
        yield* d.clickSel('[data-testid="composer"]')
        yield* d.shot('document-composer-focus')
        yield* d.typeText('Why does the second example work better?')
        yield* d.pause(200)
        yield* d.shot('document-composer-typed')
        yield* d.typeText(' @')
        yield* d.pause(400)
        yield* d.shot('document-smartchip')
        yield* d.escape()
        yield* d.js(clearField('[data-testid="composer"]', 'HTMLTextAreaElement'))
        yield* d.pause(200)
      }),
    )
    yield* d.step(
      'selection',
      Effect.gen(function* () {
        yield* d.js(`(() => {
        const range = document.createRange()
        range.selectNodeContents(document.querySelector('.doc-body p'))
        getSelection().removeAllRanges()
        getSelection().addRange(range)
        return true
      })()`)
        yield* d.shot('document-selection')
        yield* d.js('getSelection().removeAllRanges()')
      }),
    )
    yield* d.step(
      'document-context',
      Effect.gen(function* () {
        yield* d.clickSel('.doc-body p', 'right')
        yield* d.pause(300)
        yield* d.shot('document-context')
        yield* d.escape()
        yield* d.dismiss()
      }),
    )
    yield* d.step(
      'title',
      Effect.gen(function* () {
        yield* d.hoverSel('.doc-title', 300)
        yield* d.shot('document-title-hover')
        yield* d.clickSel('.doc-title')
        yield* d.shot('document-title-focus')
        yield* d.escape()
        yield* d.rest()
      }),
    )
    yield* d.step(
      'document-focus',
      Effect.gen(function* () {
        yield* d.blur()
        for (let i = 0; i < 2; i++) yield* d.tab()
        yield* d.shot('document-focus-tab2')
        for (let i = 0; i < 4; i++) yield* d.tab()
        yield* d.shot('document-focus-tab6')
        for (let i = 0; i < 12; i++) yield* d.tab()
        yield* d.shot('document-focus-tab18')
        yield* d.blur()
      }),
    )
    yield* d.step(
      'hovers',
      Effect.gen(function* () {
        const hovers = [
          ['[data-testid="menu-edit"]', 'hover-menu-label', 350],
          ['.toolbar .toolbar-icon:nth-child(2)', 'hover-toolbar-icon', 350],
          ['[data-testid="chip-model"]', 'hover-chip-tooltip', 1300],
          ['[data-testid="share"]', 'hover-share', 1300],
          ['.outline-item', 'hover-outline', 300],
          ['.tab-pill', 'hover-tab-pill', 300],
          ['.side-rail .rail-app', 'hover-rail', 1300],
          ['.header-action', 'hover-header-action', 1300],
          ['.spark-pill', 'hover-spark-pill', 600],
        ] as const
        for (const [selector, name, wait] of hovers) {
          yield* d.rest()
          yield* d.hoverSel(selector, wait)
          yield* d.shot(name)
        }
        yield* d.rest()
      }),
    )
    yield* d.step(
      'tabs-collapse',
      Effect.gen(function* () {
        yield* d.clickSel('.tabs-hide')
        yield* d.rest()
        yield* d.shot('document-tabs-collapsed')
        yield* d.clickSel('.tabs-show')
        yield* d.rest()
      }),
    )
    yield* d.step(
      'outline-jump',
      Effect.gen(function* () {
        yield* d.clickSel('.doc-outline li:nth-child(2) .outline-item')
        yield* d.pause(900)
        yield* d.rest()
        yield* d.shot('document-outline-jump')
        yield* nav.scrollTop()
      }),
    )

    for (const id of MENUBAR) {
      yield* d.step(
        `menu-${id}`,
        Effect.gen(function* () {
          yield* d.click(`menu-${id}`)
          yield* d.shot(`menu-${id}`)
          if (id === 'file') {
            yield* d.hoverSel('[data-testid="action-open"]')
            yield* d.shot('menu-file-hover')
            yield* d.hoverSel('[data-testid="action-new"]', 500)
            yield* d.shot('menu-file-new')
          }
          yield* d.dismiss()
          yield* d.escape()
        }),
      )
    }
    for (const [trigger, name] of CHIP_MENUS) {
      yield* d.step(
        name,
        Effect.gen(function* () {
          yield* d.click(trigger)
          yield* d.pause(200)
          yield* d.shot(name)
          if (trigger === 'chip-model') {
            const firstModel = (yield* manager.snapshot).models[0]
            if (firstModel) {
              yield* d.hoverSel(d.tid(`pick-${firstModel.id}`), 700)
              yield* d.shot('menu-style-cascade')
            }
            yield* d.click('pick-options')
            yield* d.shot('menu-style-options')
          }
          yield* d.dismiss()
          yield* d.escape()
        }),
      )
    }
    yield* d.step(
      'share-dialog',
      Effect.gen(function* () {
        yield* d.click('share')
        yield* d.pause(300)
        yield* d.shot('share-dialog')
        yield* d.escape()
        yield* d.pause(300)
      }),
    )
    // Docs opens its find bar and its link dialog; these show what HideGPT does.
    yield* d.step(
      'shortcuts',
      Effect.gen(function* () {
        yield* d.key('f', 'KeyF', 70, 4)
        yield* d.pause(400)
        yield* d.shot('shortcut-cmd-f')
        yield* d.escape()
        yield* nav.openDemo()
        yield* d.key('k', 'KeyK', 75, 4)
        yield* d.pause(400)
        yield* d.shot('shortcut-cmd-k')
        yield* d.escape()
      }),
    )

    // View → Show non-printing characters: tool activity callouts.
    yield* d.step(
      'callouts',
      Effect.gen(function* () {
        const restore = yield* nav.withBlocks([callout], false)
        yield* d.click('menu-view')
        yield* d.click('action-output-only')
        yield* d.pause(400)
        yield* nav.scrollBottom()
        yield* d.rest()
        yield* d.shot('document-callout')
        yield* d.clickSel('.callout summary')
        yield* d.shot('document-callout-open')
        yield* d.click('menu-view')
        yield* d.click('action-output-only')
        yield* restore
      }),
    )
    yield* d.step(
      'suggestion-kinds',
      Effect.gen(function* () {
        const restore = yield* nav.withBlocks([questionSuggestion, formatSuggestion], true)
        yield* d.pause(500)
        yield* nav.scrollBottom()
        yield* d.rest()
        yield* d.shot('document-suggestion-kinds')
        yield* d.hoverSel('.suggestion-text', 1600)
        yield* d.shot('document-suggestion-tooltip')
        yield* d.hoverSel('.suggestion-act.accept', 900)
        yield* d.shot('document-suggestion-accept-hover')
        yield* d.rest()
        yield* restore
      }),
    )
    yield* d.step(
      'waiting',
      Effect.gen(function* () {
        const restore = yield* nav.withBlocks([question], true)
        yield* d.pause(500)
        yield* nav.scrollToQuestion()
        yield* d.shot('document-waiting')
        yield* d.hoverSel('[data-testid="stop-turn"]', 1200)
        yield* d.shot('document-stop-hover')
        yield* d.rest()
        yield* restore
      }),
    )
    yield* d.step(
      'auth-banner',
      Effect.gen(function* () {
        const undo = yield* nav.show({ fields: { requiresAuth: true, account: null } })
        yield* d.pause(300)
        yield* d.shot('document-auth-banner')
        yield* undo
      }),
    )
    yield* d.step(
      'opening',
      Effect.gen(function* () {
        const undo = yield* nav.show({ fields: { openingThreadId: nav.demo.id } })
        yield* d.pause(300)
        yield* d.shot('document-opening')
        yield* undo
      }),
    )
    yield* d.step(
      'error-banner',
      Effect.gen(function* () {
        yield* manager.notify('Docs couldn’t save your last change.')
        yield* d.waitFor('[data-testid="error-banner"]', 'The error banner')
        yield* d.rest()
        yield* d.shot('document-error')
        yield* d.hoverSel('[data-testid="error-refresh"]')
        yield* d.shot('document-error-hover')
        yield* d.clickSel('.error-details-toggle')
        yield* d.rest()
        yield* d.shot('document-error-details')
        yield* d.click('error-dismiss')
        yield* d.pause(200)
      }),
    )
    for (const [width, height] of [
      [1100, 800],
      [960, 800],
      [760, 700],
    ] as const) {
      yield* d.step(
        `narrow-${width}`,
        Effect.gen(function* () {
          yield* d.emulate(width, height)
          yield* d.rest()
          yield* d.shot(`document-${width}`)
          yield* d.click('toolbar-more')
          yield* d.shot(`toolbar-more-${width}`)
          yield* d.dismiss()
          yield* d.escape()
        }),
      )
    }
    yield* nav.goHome()
    yield* d.shot('home-760')
    yield* d.emulate(1402, 877)

    // Switching "accounts" swaps the document library.
    yield* d.step(
      'library-switch',
      Effect.gen(function* () {
        yield* d.click('menu-account')
        yield* d.click('library-claude')
        yield* d.waitFor('[data-testid="docs-home"]', 'The other home')
        yield* d.waitUntil(`!document.querySelector('.top-progress')`, 'The library switch finishing')
        yield* d.shot('claude-home')
        yield* d.click('menu-account')
        yield* d.shot('account-menu-claude')
        yield* d.click('library-codex')
        yield* d.pause(400)
      }),
    )
  })
