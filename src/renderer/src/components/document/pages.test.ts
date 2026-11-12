/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Paginator } from './pages'
import { PAGE_HEIGHT, PAGE_PITCH } from './pageLayout'

/*
 * jsdom lays nothing out, so these tests stand in a tiny layout: rows stack from the top
 * margin, units stack inside their row, each unit is as tall as its `data-h`, and a pushed
 * unit's top margin is its `--page-break`. Lines are 20px apart. Reading a unit, its style or
 * its lines inside a skipped row throws, since in Chromium that read would force the row's layout.
 */

const MARGIN = 96
type Box = { top: number; height: number }

let paper: HTMLElement
let flow: HTMLElement
let paginator: Paginator | undefined
let frames: FrameRequestCallback[] = []
let observer: { deliver: (rows: HTMLElement[]) => void } | undefined
const skipped = new Set<Element>()
/** Whether `content-visibility` renders a row; tests that scroll replace it. */
let rendered = (row: Element) => !skipped.has(row)

/** Throws for an element inside a row that isn't rendered. */
function guard(el: Element) {
  const row = el.closest('.doc-block')
  if (row && row !== el && !rendered(row)) throw new Error('read inside a skipped row')
}

function layout(): Map<Element, Box> {
  const boxes = new Map<Element, Box>()
  let y = MARGIN
  for (const row of Array.from(flow.children)) {
    const top = y
    for (const unit of Array.from(row.querySelectorAll<HTMLElement>('.doc-body > *'))) {
      if (unit.hasAttribute('data-page-break')) y += parseFloat(unit.style.getPropertyValue('--page-break'))
      const height = Number(unit.dataset.h)
      boxes.set(unit, { top: y, height })
      y += height
    }
    boxes.set(row, { top, height: y - top })
  }
  boxes.set(paper, { top: 0, height: y + MARGIN })
  return boxes
}

function rect({ top, height }: Box): DOMRect {
  return { top, height, bottom: top + height, left: 0, right: 816, width: 816, x: 0, y: top, toJSON: () => ({}) }
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

const units = (row: Element) => Array.from(row.querySelectorAll<HTMLElement>('.doc-body > *'))

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
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
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
    const lines = Array.from({ length: Math.round(height / 20) }, (_, line) => rect({ top: top + line * 20, height: 20 }))
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
})

afterEach(() => {
  paginator?.dispose()
  paginator = undefined
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
    watch.observe(paper, { subtree: true, attributes: true, attributeFilter: ['style', 'data-page-break', 'data-page-split'] })
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
})
