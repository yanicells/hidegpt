/** @vitest-environment jsdom */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { HideGptApi, MenuAction } from '../../shared/api'
import { emptySnapshot, type Snapshot } from '../../shared/model'
import { App } from './app'

afterEach(cleanup)

const STYLES = join(import.meta.dirname, 'styles')

/** The block between the braces that open at `open`, braces nested. */
function braced(css: string, open: number): string {
  let depth = 0
  for (let index = open; index < css.length; index++) {
    if (css[index] === '{') depth++
    if (css[index] === '}' && --depth === 0) return css.slice(open + 1, index)
  }
  throw new Error('unbalanced braces')
}

/** Every selector that an `@media print` rule in the app's stylesheets sets to `display: none`. */
function printHidden(): string {
  const selectors: string[] = []
  for (const file of readdirSync(STYLES).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(join(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const media of css.matchAll(/@media print\s*\{/g)) {
      const body = braced(css, media.index + media[0].length - 1)
      for (const rule of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/display:\s*none/.test(rule[2]!)) selectors.push(rule[1]!.trim())
      }
    }
  }
  return selectors.join(', ')
}

async function mountDocument() {
  let send: (action: MenuAction) => void = () => undefined
  const snapshot: Snapshot = {
    ...emptySnapshot(),
    status: 'ready',
    route: { kind: 'doc', threadId: 'thr_1' },
    title: 'Photosynthesis',
    hasOlder: true,
    blocks: [
      { kind: 'user', id: 'u1', text: 'How does photosynthesis work?' },
      { kind: 'agent', id: 'a1', text: 'Light becomes chemical energy.' },
    ],
  }
  window.hidegpt = {
    getSnapshot: () => ({ snapshot, seq: 0 }),
    onSnapshot: () => () => undefined,
    onMenu: (handler: (action: MenuAction) => void) => {
      send = handler
      return () => undefined
    },
    dispatch: async () => ({ ok: true }),
    platform: 'darwin',
  } as Partial<HideGptApi> as HideGptApi
  render(<App />)
  // The find bar is open too: it floats over the canvas and must not print either.
  await act(async () => send('find'))
  await screen.findByTestId('find-bar')
}

describe('print', () => {
  it('prints the page alone: everything beside it on the way up, and its own controls, are hidden', async () => {
    await mountDocument()
    const hidden = printHidden()
    const paper = document.querySelector('.paper')!
    expect(paper).not.toBeNull()
    expect(document.querySelector('.find-anchor')).not.toBeNull()

    const shown: string[] = []
    for (let node: Element = paper; node !== document.body; node = node.parentElement!) {
      for (const sibling of node.parentElement!.children) {
        if (sibling !== node && !sibling.matches(hidden)) shown.push(sibling.outerHTML.slice(0, 80))
      }
    }
    expect(shown).toEqual([])

    for (const control of ['.page-sheets', '.load-older', '.composer-wrap']) {
      expect(paper.querySelector(control)?.matches(hidden)).toBe(true)
    }
    // The page text itself prints.
    expect(paper.querySelector('.paper-flow')?.matches(hidden)).toBe(false)
    expect(paper.textContent).toContain('Light becomes chemical energy.')
  })
})
