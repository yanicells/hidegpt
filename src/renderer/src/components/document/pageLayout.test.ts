import { describe, expect, it } from 'vitest'

import { layoutPages, type Lines, type PageRow, type PageUnit } from './pageLayout'

// Page 1's text area ends at 960 (1056 - 96); page 2's starts at 1168 (1072 + 96).
const unit = (el: string, offset: number, height: number, kind: 'div' | 'p' | 'h1' = 'div'): PageUnit<string> => ({
  el,
  offset,
  height,
  heading: kind === 'h1',
  paragraph: kind === 'p',
})

const row = (top: number, units: PageUnit<string>[], extra: Partial<PageRow<string>> = {}): PageRow<string> => {
  const height = Math.max(0, ...units.map((u) => u.offset + u.height))
  return { top, height, live: true, measured: { units, height }, applied: 0, ...extra }
}

const noLines = () => null

describe('layoutPages', () => {
  it('pushes a unit that crosses the bottom margin onto the next page, keeping its gap', () => {
    const { breaks, pages } = layoutPages([row(96, [unit('a', 0, 800), unit('b', 820, 100)])], noLines)
    // b sits at 916; the gap above it is 20, and it moves to 1168.
    expect(breaks).toEqual([[{ kind: 'push', el: 'b', margin: 272, push: 252 }]])
    expect(pages).toBe(2)
  })

  it('splits a paragraph at its first line that does not fit', () => {
    const lines: Lines = { tops: Array.from({ length: 20 }, (_, i) => i * 20), lineHeight: 20 }
    const { breaks } = layoutPages([row(96, [unit('p', 700, 400, 'p')])], () => lines)
    // The paragraph starts at 796; its line at +160 is the first to end past 960.
    expect(breaks).toEqual([[{ kind: 'split', el: 'p', start: 161, end: 372, push: 212 }]])
  })

  it('moves a question with the block after it when that block has to move', () => {
    const rows = [row(96, [unit('q', 804, 40, 'h1')]), row(940, [unit('x', 0, 100)])]
    expect(layoutPages(rows, noLines).breaks).toEqual([[{ kind: 'push', el: 'q', margin: 1072, push: 268 }], []])
    // A skipped question can't move this frame, so the block goes alone.
    rows[0].live = false
    expect(layoutPages(rows, noLines).breaks[1]).toEqual([{ kind: 'push', el: 'x', margin: 228, push: 228 }])
  })

  it('gives the same breaks whether or not the cached rows still carry the last pass', () => {
    const units = [unit('a', 0, 800), unit('b', 820, 100)]
    const fresh = layoutPages([row(96, units), row(1016, [unit('c', 0, 50)])], noLines)
    // Row 1 kept its break, so it is 252 taller and pushes row 2 down by as much.
    const cached = layoutPages(
      [row(96, units, { height: 1172, applied: 252 }), row(1268, [unit('c', 0, 50)])],
      noLines,
    )
    expect(cached).toEqual(fresh)
    expect(fresh.breaks[1]).toEqual([])
  })

  it('does not move rows below a skipped one by breaks that cannot land yet', () => {
    // An off-screen row still has the height it was last painted at, 400 more than now.
    const skipped = row(96, [unit('a', 0, 800), unit('b', 820, 100)], { live: false, height: 1320 })
    const { breaks, pages } = layoutPages([skipped, row(1416, [unit('c', 0, 500)])], noLines)
    // Its own break is ready for when it renders...
    expect(breaks[0]).toEqual([{ kind: 'push', el: 'b', margin: 272, push: 252 }])
    // ...but c is where layout put it, at 1416, and fits; counting the push again would break it.
    expect(breaks[1]).toEqual([])
    expect(pages).toBe(2)
  })

  it("replaces a row's first unit's own margin, not the space the row above leaves", () => {
    // The question row ends 8px below its heading (the heading's bottom margin, inside the row),
    // and is off-screen, so the answer moves without it.
    const question = row(96, [unit('q', 700, 40, 'h1')], { height: 748, live: false })
    const { breaks } = layoutPages([question, row(844, [unit('a', 0, 200)])], noLines)
    // The answer's first paragraph sits flush with its row's top: a 324px margin lands it at 1168.
    expect(breaks[1]).toEqual([{ kind: 'push', el: 'a', margin: 324, push: 324 }])
  })

  it('places a row that is one unit by where it sits without its own push', () => {
    const above = row(96, [unit('x', 0, 784)])
    // The composer was pushed 200 last pass. That is its top margin, so its box starts at 1100, not 900.
    const composer = row(1100, [unit('c', -200, 100)], { height: 100, applied: 200 })
    const fresh = layoutPages([above, row(900, [unit('c', 0, 100)])], noLines)
    expect(layoutPages([above, composer], noLines)).toEqual(fresh)
    expect(fresh.breaks[1]).toEqual([{ kind: 'push', el: 'c', margin: 288, push: 268 }])
  })

  it('keeps an unmeasured row as it is and still counts it', () => {
    const unmeasured: PageRow<string> = { top: 96, height: 2900, live: false, measured: null, applied: 0 }
    const { breaks, pages } = layoutPages([unmeasured, row(2996, [unit('c', 0, 50)])], noLines)
    expect(breaks[0]).toBeNull()
    expect(pages).toBe(3)
  })
})
