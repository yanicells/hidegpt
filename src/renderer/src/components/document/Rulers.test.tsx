/** @vitest-environment jsdom */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Ruler, VerticalRuler, rulerTicks } from './Rulers'

afterEach(cleanup)

/** Each tick in a path as [position along the ruler, depth]. */
function parse(d: string, vertical: boolean): Array<[number, number]> {
  const pattern = vertical ? /M(\d+) (\d+)h(\d+)v1h-\d+z/g : /M(\d+) (\d+)h1v(\d+)h-1z/g
  return [...d.matchAll(pattern)].map((m) => [Number(vertical ? m[2] : m[1]), Number(m[3])])
}

describe('ruler ticks', () => {
  it('ticks every eighth of an inch, deeper at half inches, dark over the margins', () => {
    const { margin, content } = rulerTicks(816, false)
    const dark = parse(margin, false)
    const light = parse(content, false)

    const eighths = Array.from({ length: 69 }, (_, k) => k * 12)
    expect([...dark, ...light].map(([at]) => at).sort((a, b) => a - b)).toEqual(eighths)
    expect(dark.map(([at]) => at)).toEqual(eighths.filter((at) => at <= 96 || at >= 720))
    for (const [at, depth] of [...dark, ...light]) expect(depth).toBe(at % 96 === 48 ? 8 : 4)
  })

  it('runs the vertical ticks down one page, flush with the ruler edge', () => {
    const { margin, content } = rulerTicks(1056, true)
    expect(parse(margin, true).map(([at]) => at)).toEqual([
      ...Array.from({ length: 9 }, (_, k) => k * 12),
      ...Array.from({ length: 9 }, (_, k) => 960 + k * 12),
    ])
    expect(parse(content, true)).toHaveLength(71)
    // Every tick ends at x=8, the ruler's right edge.
    for (const [, x, depth] of (margin + content).matchAll(/M(\d+) \d+h(\d+)/g)) {
      expect(Number(x) + Number(depth)).toBe(8)
    }
  })
})

describe('rulers', () => {
  it('colours the margin ticks with the margin path and the content ticks with the content path', () => {
    for (const [Component, length, vertical] of [
      [Ruler, 816, false],
      [VerticalRuler, 1056, true],
    ] as const) {
      const { container, unmount } = render(<Component />)
      const ticks = rulerTicks(length, vertical)
      expect(container.querySelector('.ruler-tick-margin')?.getAttribute('d')).toBe(ticks.margin)
      expect(container.querySelector('.ruler-tick-content')?.getAttribute('d')).toBe(ticks.content)
      unmount()
    }
  })

  it('labels the top margin "1", like the horizontal ruler labels the left one', () => {
    const { container } = render(<VerticalRuler />)
    const labels = [...container.querySelectorAll<HTMLElement>('.vruler-num')]
    expect(labels.map((label) => label.textContent)).toEqual(['1', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    // Each sits half a pixel below its tick: the top "1" on the page's top edge
    // (ticks start 16px down), the content's "1" two inches lower.
    expect(labels[0].style.top).toBe('16.5px')
    expect(labels[1].style.top).toBe('208.5px')
  })
})
