/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CURRENT_HIGHLIGHT, findRanges, MATCH_HIGHLIGHT, paintMatches } from './find'

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function page(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}

const texts = (ranges: Range[]) => ranges.map((range) => range.toString())

describe('findRanges', () => {
  it('finds every match case-insensitively, across inline formatting but not across paragraphs', () => {
    const root = page(
      '<div class="doc-block"><p>Light <b>A</b>TP and atp.</p><p>end</p><p>ATP</p></div><div class="doc-block"><h1>ATP synthase</h1></div>',
    )
    expect(texts(findRanges(root, 'atp'))).toEqual(['ATP', 'atp', 'ATP', 'ATP'])
    // "end" + "ATP" in the next paragraph must not join into "dATP".
    expect(findRanges(root, 'dATP')).toEqual([])
    expect(texts(findRanges(root, 'ATP', true))).toEqual(['ATP', 'ATP', 'ATP'])
  })

  it('leaves out the writing line, decoration, controls and a folded callout body', () => {
    const root = page(
      '<p>alpha</p>' +
        '<div class="composer-wrap"><p>alpha draft</p></div>' +
        '<p aria-hidden="true">alpha</p>' +
        '<button>alpha</button>' +
        '<details><summary>alpha step</summary><pre>alpha output</pre></details>' +
        '<details open><summary>s</summary><pre>alpha shown</pre></details>',
    )
    expect(findRanges(root, 'alpha').map((range) => range.startContainer.textContent)).toEqual([
      'alpha',
      'alpha step',
      'alpha shown',
    ])
  })

  it('maps offsets past characters whose lower case is longer', () => {
    const root = page('<p>İstanbul and istanbul</p>')
    expect(texts(findRanges(root, 'and'))).toEqual(['and'])
  })
})

describe('paintMatches', () => {
  it('registers all matches and the current one on top, and clears both', () => {
    const registry = new Map<string, { ranges: Range[]; priority: number }>()
    class FakeHighlight {
      ranges: Range[]
      priority = 0
      constructor(...ranges: Range[]) {
        this.ranges = ranges
      }
    }
    vi.stubGlobal('Highlight', FakeHighlight)
    vi.stubGlobal('CSS', { highlights: registry })
    const ranges = findRanges(page('<p>a b a</p>'), 'a')

    paintMatches(ranges, 1)
    expect(registry.get(MATCH_HIGHLIGHT)?.ranges).toEqual(ranges)
    expect(registry.get(CURRENT_HIGHLIGHT)?.ranges).toEqual([ranges[1]])
    expect(registry.get(CURRENT_HIGHLIGHT)?.priority).toBe(1)

    paintMatches([], 0)
    expect(registry.size).toBe(0)
  })
})
