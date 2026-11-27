/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { Paginator } from './pages'
import { PAGE_HEIGHT, PAGE_PITCH } from './pageLayout'

/*
 * jsdom lays nothing out, so these tests stand in a tiny layout: rows stack from the top
 * margin, units stack inside their row, each unit is as tall as its `data-h`, and a pushed
 * unit's top margin is its `--page-break`. Lines are 20px apart. Reading a unit, its style or
 * its lines inside a skipped row throws, since in Chromium that read would force the row's layout.
 * `zoom` scales client rects, as the page zoom does.
 */

const MARGIN = 96
type Box = { top: number; height: number }

let paper: HTMLElement
let flow: HTMLElement
let paginator: Paginator | undefined
let frames: FrameRequestCallback[] = []
let observer: { deliver: (rows: HTMLElement[]) => void } | undefined
let boxReads: MockInstance<() => DOMRect>
let zoom = 1
const skipped = new Set<Element>()
/** Whether `content-visibility` renders a row; tests that scroll replace it. */
let rendered = (row: Element) => !skipped.has(row)

/** Throws for an element inside a row that isn't rendered. */
function guard(el: Element) {
  const row = el.closest('.doc-block')
  if (row && row !== el && !rendered(row)) throw new Error('read inside a skipped row')
}

/** The last layout, kept until anything in the paper changes: `takeRecords` tells synchronously. */
let laidOut: Map<Element, Box> | null = null
let edits: MutationObserver

function layout(): Map<Element, Box> {
  if (edits.takeRecords().length) laidOut = null
  if (laidOut) return laidOut
  const boxes = new Map<Element, Box>()
  let y = MARGIN
  for (const row of Array.from(flow.children) as HTMLElement[]) {
    if (!row.classList.contains('doc-block')) {
      // A row that is one unit (the composer): its break is its own top margin, outside its box.
      if (row.hasAttribute('data-page-break')) y += parseFloat(row.style.getPropertyValue('--page-break'))
      boxes.set(row, { top: y, height: Number(row.dataset.h) })
      y += Number(row.dataset.h)
      continue
    }
    const top = y
    for (const unit of units(row)) {
      if (unit.hasAttribute('data-page-break')) y += parseFloat(unit.style.getPropertyValue('--page-break'))
      const height = Number(unit.dataset.h)
      boxes.set(unit, { top: y, height })
      y += height
    }
    boxes.set(row, { top, height: y - top })
  }
  boxes.set(paper, { top: 0, height: y + MARGIN })
  laidOut = boxes
  return boxes
}

function rect(box: Box): DOMRect {
  const [top, height, width] = [box.top * zoom, box.height * zoom, 816 * zoom]
  return { top, height, bottom: top + height, left: 0, right: width, width, x: 0, y: top, toJSON: () => ({}) }
}

/** A block of units, as Markdown renders an answer: `row > div > .doc-body > units`. */
function block(...heights: number[]): HTMLElement {
  const row = document.createElement('div')
  row.className = 'doc-block'
  const body = document.createElement('div')
  body.className = 'doc-body'
  for (const height of heights) body.append(unit(height))
  row.append(document.createElement('div'))
  row.firstElementChild!.append(body)
  flow.append(row)
  return row
}

function unit(height: number, tag = 'div'): HTMLElement {
  const el = document.createElement(tag)
  el.dataset.h = String(height)
  el.textContent = tag
  return el
}

/** A row's units, walked rather than queried so the stub's reads don't count as the paginator's. */
const units = (row: Element): HTMLElement[] =>
  row.classList.contains('doc-block')
    ? (Array.from(row.firstElementChild!.firstElementChild!.children) as HTMLElement[])
    : [row as HTMLElement]

/** The composer: a row that paginates whole. */
function composer(height: number): HTMLElement {
  const row = document.createElement('div')
  row.className = 'composer-wrap'
  row.dataset.h = String(height)
  flow.append(row)
  return row
}

/** Units of rendered rows that cross a page's top or bottom margin. */
function misplaced(): HTMLElement[] {
  const boxes = layout()
  return Array.from(flow.children)
    .filter(rendered)
    .flatMap(units)
    .filter((el) => {
      const { top, height } = boxes.get(el)!
      const page = Math.floor(top / PAGE_PITCH) * PAGE_PITCH
      return top < page + MARGIN || top + height > page + PAGE_HEIGHT - MARGIN
    })
}

/** Every unit's written break, in document order. */
function breaks(): string[] {
  return Array.from(flow.children)
    .flatMap(units)
    .map((el) => ['--page-break', '--split-start', '--split-end'].map((name) => el.style.getPropertyValue(name)).join())
}

/** Runs the frames queued so far: MutationObserver records first, as in a browser. */
async function nextFrame() {
  await Promise.resolve()
  const queued = frames
  frames = []
  for (const callback of queued) callback(0)
}

beforeEach(() => {
  frames = []
  skipped.clear()
  zoom = 1
  rendered = (row) => !skipped.has(row)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        const deliver = (rows: HTMLElement[]) => {
          const boxes = layout()
          const entries = rows.map((target) => ({
            target,
            borderBoxSize: [{ blockSize: boxes.get(target)!.height, inlineSize: 816 }],
          }))
          callback(entries as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver)
        }
        observer = { deliver }
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  boxReads = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    guard(this)
    return rect(layout().get(this) ?? { top: 0, height: 0 })
  })
  const computed = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
    guard(el)
    return { width: computed(el).width, lineHeight: '20px' } as CSSStyleDeclaration
  })
  // jsdom has no Range.getClientRects: one rect per 20px line of the paragraph's own height.
  Range.prototype.getClientRects = function (this: Range) {
    const el = this.startContainer as HTMLElement
    guard(el)
    const { top, height } = layout().get(el)!
    const lines = Array.from({ length: Math.round(height / 20) }, (_, line) =>
      rect({ top: top + line * 20, height: 20 }),
    )
    return lines as unknown as DOMRectList
  }
  // jsdom has no checkVisibility; pages.ts asks a row's first child.
  Element.prototype.checkVisibility = function (this: Element) {
    return rendered(this.parentElement!)
  }
  paper = document.createElement('div')
  paper.style.width = '816px'
  flow = document.createElement('div')
  flow.className = 'paper-flow'
  paper.append(flow)
  document.body.append(paper)
  laidOut = null
  // Delivery drains the records too, so it drops the layout as well.
  edits = new MutationObserver(() => (laidOut = null))
  edits.observe(paper, { subtree: true, childList: true, attributes: true, characterData: true })
})

afterEach(() => {
  paginator?.dispose()
  paginator = undefined
  edits.disconnect()
  paper.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (Element.prototype as Partial<Element>).checkVisibility
  delete (Range.prototype as Partial<Range>).getClientRects
})

describe('Paginator', () => {
  it('breaks a row in the callback that reports it rendered, before the visibility event', () => {
    block(800)
    const below = block(100)
    skipped.add(below)
    paginator = new Paginator(paper, () => {})
    expect(units(below)[0].hasAttribute('data-page-break')).toBe(false)

    // Scrolled into view: the observer reports the row; the state-change event comes later.
    skipped.delete(below)
    observer!.deliver([below])

    expect(units(below)[0].style.getPropertyValue('--page-break')).toBe(`${PAGE_PITCH + MARGIN - 896}px`)
    expect(misplaced()).toEqual([])
  })

  it('stops counting the break of an element React removed', async () => {
    const above = block(800, 100)
    block(600, 200)
    paginator = new Paginator(paper, () => {})
    expect(misplaced()).toEqual([])

    // A streamed paragraph turns into a table: its pushed element is gone.
    const pushed = units(above)[1]
    pushed.replaceWith(unit(100, 'table'))
    await nextFrame()

    expect(misplaced()).toEqual([])
  })

  it('writes nothing when a break moves by less than half a pixel', async () => {
    const row = block(800, 100)
    paginator = new Paginator(paper, () => {})
    const pushed = units(row)[1]
    const margin = pushed.style.getPropertyValue('--page-break')
    expect(margin).toBe(`${PAGE_PITCH + MARGIN - 896}px`)

    const writes: MutationRecord[] = []
    const watch = new MutationObserver((records) => writes.push(...records))
    watch.observe(paper, {
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-page-break', 'data-page-split'],
    })
    const first = units(row)[0]
    first.dataset.h = '800.3'
    first.textContent = 'grew'
    await nextFrame()
    writes.push(...watch.takeRecords())
    watch.disconnect()

    expect(writes).toEqual([])
    expect(pushed.style.getPropertyValue('--page-break')).toBe(margin)
  })

  it('measures again a row that resized while skipped, once it renders', async () => {
    const top = block(300)
    const row = block(300, 100, 100)
    paginator = new Paginator(paper, () => {})
    skipped.add(row)
    row.dispatchEvent(Object.assign(new Event('contentvisibilityautostatechange'), { skipped: true }))
    units(top)[0].textContent = 'edited'
    await nextFrame()

    // An image in it loads while it's skipped: it grows with no mutation.
    units(row)[0].dataset.h = '520'
    skipped.delete(row)
    observer!.deliver([row])

    expect(misplaced()).toEqual([])
  })

  it('never reads lines inside a skipped row', async () => {
    const top = block(300)
    const row = block(200)
    units(row)[0].replaceWith(unit(200, 'p'))
    paginator = new Paginator(paper, () => {})
    skipped.add(row)
    row.dispatchEvent(Object.assign(new Event('contentvisibilityautostatechange'), { skipped: true }))

    // The block above grows, so the skipped paragraph now crosses a page: it moves whole for now.
    units(top)[0].dataset.h = '700'
    units(top)[0].textContent = 'grew'
    await nextFrame()

    expect(units(row)[0].hasAttribute('data-page-break')).toBe(true)
  })

  it('keeps the break of an element that moved to an earlier row', async () => {
    const first = block(800)
    const second = block(100, 50)
    paginator = new Paginator(paper, () => {})
    const moved = units(second)[0]
    expect(moved.hasAttribute('data-page-break')).toBe(true)

    first.querySelector('.doc-body')!.append(moved)
    await nextFrame()

    expect(moved.hasAttribute('data-page-break')).toBe(true)
    expect(misplaced()).toEqual([])
  })

  it('breaks a row its own breaks brought into view, in the same callback', () => {
    // Rows render while their top is above the window's bottom: the last one never has.
    rendered = (row) => layout().get(row)!.top < 950
    const first = block(800)
    block(100)
    const last = block(100)
    paginator = new Paginator(paper, () => {})
    expect(rendered(last)).toBe(false)

    // An image above shrinks: the row below fits again and drops its break, which brings
    // the last row into view, where it now crosses the page.
    units(first)[0].dataset.h = '700'
    observer!.deliver([first])

    expect(rendered(last)).toBe(true)
    expect(misplaced()).toEqual([])
  })

  it('settles in one pass when the composer it pushed reports its size', () => {
    const above = block(700)
    const last = composer(100)
    const passes = vi.fn()
    paginator = new Paginator(paper, passes)
    expect(last.hasAttribute('data-page-break')).toBe(false)
    passes.mockClear()

    // An image above loads: the composer crosses the page and is pushed. Its push is a margin
    // outside its box, so reading its box back must not look like an unplanned resize.
    units(above)[0].dataset.h = '800'
    observer!.deliver([above])

    expect(last.style.getPropertyValue('--page-break')).toBe(`${PAGE_PITCH + MARGIN - 896}px`)
    expect(misplaced()).toEqual([])
    expect(passes).toHaveBeenCalledTimes(1)
  })

  it('reads only the edited row and the last one in a 600-row document', async () => {
    const rows = Array.from({ length: 600 }, () => block(100))
    paginator = new Paginator(paper, () => {})
    // Spies that call through, recording which element each query ran on.
    const queries = [vi.spyOn(Element.prototype, 'querySelector'), vi.spyOn(Element.prototype, 'querySelectorAll')]
    boxReads.mockClear()

    const last = rows.at(-1)!
    units(last)[0].dataset.h = '150'
    units(last)[0].textContent = 'edited'
    await nextFrame()

    // The paper, the row and its one unit.
    expect(boxReads.mock.calls.length).toBeLessThanOrEqual(4)
    expect(queries.flatMap((query) => query.mock.contexts).every((el) => el === last)).toBe(true)
    expect(misplaced()).toEqual([])
  })

  it('moves the rows under an edited middle row without reading them', async () => {
    const rows = Array.from({ length: 600 }, () => block(100))
    paginator = new Paginator(paper, () => {})
    boxReads.mockClear()

    units(rows[300])[0].dataset.h = '180'
    units(rows[300])[0].textContent = 'edited'
    await nextFrame()

    // The paper, the row, its unit and the last row, which checks where the rest went.
    expect(boxReads.mock.calls.length).toBeLessThanOrEqual(4)
    expect(misplaced()).toEqual([])
  })

  it('places the same breaks as a full recompute after a middle row resizes on its own', () => {
    const rows = Array.from({ length: 60 }, (_, index) => block(100 + (index % 7) * 30, 60))
    paginator = new Paginator(paper, () => {})

    // An image in a middle row loads: no mutation, only the observer reports it.
    units(rows[30])[0].dataset.h = '420'
    observer!.deliver([rows[30]])
    const incremental = breaks()

    paginator.dispose()
    paginator = new Paginator(paper, () => {})
    expect(breaks()).toEqual(incremental)
    expect(misplaced()).toEqual([])
  })

  it('reads every row again when a row moved without any report', async () => {
    const rows = Array.from({ length: 60 }, () => block(100))
    paginator = new Paginator(paper, () => {})

    // A row grows with nothing reporting it, then a pass runs for an edit at the end.
    units(rows[10])[0].dataset.h = '180'
    units(rows.at(-1)!)[0].textContent = 'edited'
    await nextFrame()

    expect(misplaced()).toEqual([])
  })

  it('reads every row again after a zoom change', async () => {
    const rows = Array.from({ length: 60 }, () => block(100))
    paginator = new Paginator(paper, () => {})
    boxReads.mockClear()

    zoom = 1.25
    units(rows.at(-1)!)[0].textContent = 'edited'
    await nextFrame()

    const read = new Set(boxReads.mock.contexts)
    expect(rows.every((row) => read.has(row))).toBe(true)
    expect(misplaced()).toEqual([])
  })
})
