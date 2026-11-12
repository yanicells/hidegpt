import { useLayoutEffect, useState, type RefObject } from 'react'

import { layoutPages, type Lines, type PageBreak, type PageRow, type PageUnit } from './pageLayout'

export { PAGE_HEIGHT, PAGE_PITCH } from './pageLayout'

/**
 * What paginates inside a block: questions, images, callouts, each top-level paragraph,
 * heading, table or code block of an answer, and each top-level list item. Answer wrappers
 * are skipped in favour of their contents. Any other row (the composer, the "Show earlier
 * text" link) paginates whole.
 */
const BLOCK_UNITS = [
  ':scope > :not(:has(> .doc-body))',
  '.doc-body > :not(ul, ol)',
  '.doc-body > :is(ul, ol) > li',
].join(', ')

/**
 * Paginates the print layout and returns how many sheets to draw. A paragraph that
 * crosses a page's bottom margin breaks between its lines; anything else moves to the
 * next page whole. Text edits (streaming included) are coalesced into at most one pass
 * per frame; a row that changes size on its own (it scrolled into view, an image loaded)
 * is fixed in the same frame, before it paints.
 */
export function usePages(paperRef: RefObject<HTMLElement | null>): number {
  const [pages, setPages] = useState(1)
  useLayoutEffect(() => {
    const paper = paperRef.current
    if (!paper) return
    const paginator = new Paginator(paper, setPages)
    return () => paginator.dispose()
  }, [paperRef])
  return pages
}

/** A row's units as last measured with its breaks cleared, plus lines read so far. */
type Geometry = { units: PageUnit<HTMLElement>[]; height: number; lines: Map<HTMLElement, Lines | null> }

/** How many passes a frame's ResizeObserver callbacks may run before deferring to the next frame. */
const MAX_SYNC_PASSES = 3

/**
 * Keeps each row's geometry cached and measures a row only when it is rendered and its
 * contents changed, so an off-screen block that `content-visibility` skips is never laid
 * out just to be measured. Pagination itself is arithmetic (`layoutPages`).
 */
class Paginator {
  private readonly geometry = new WeakMap<HTMLElement, Geometry>()
  /** The breaks written into each row, by element. */
  private readonly written = new WeakMap<HTMLElement, Map<HTMLElement, PageBreak<HTMLElement>>>()
  /** From `contentvisibilityautostatechange`; absent until the browser first decides. */
  private readonly skipped = new WeakMap<Element, boolean>()
  private readonly dirty = new Set<HTMLElement>()
  /** Rows measured this frame: their next resize is a pass's own breaks landing. */
  private readonly measured = new Set<HTMLElement>()
  private readonly observed = new Set<HTMLElement>()
  private readonly mutations: MutationObserver
  private readonly resizes: ResizeObserver | null
  private width = ''
  private frame = 0
  /** Passes run this frame; cleared by the next frame's callback. */
  private passes = 0
  private resetFrame = 0
  private disposed = false

  constructor(
    private readonly paper: HTMLElement,
    private readonly onPages: (pages: number) => void,
  ) {
    // Breaks left by an earlier instance (a remount) aren't in this one's books.
    for (const el of Array.from(paper.querySelectorAll<HTMLElement>('[data-page-break], [data-page-split]'))) clearBreak(el)
    this.mutations = new MutationObserver((records) => this.onMutations(records))
    // Our own break writes are attributes outside the filter, so they don't retrigger this.
    this.mutations.observe(paper, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-streaming'],
    })
    this.resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => this.onResize(entries))
    paper.addEventListener('contentvisibilityautostatechange', this.onVisibility, true)
    void document.fonts?.ready.then(() => {
      if (this.disposed) return
      this.width = ''
      this.schedule()
    })
    this.run()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    cancelAnimationFrame(this.resetFrame)
    this.mutations.disconnect()
    this.resizes?.disconnect()
    this.paper.removeEventListener('contentvisibilityautostatechange', this.onVisibility, true)
  }

  private schedule() {
    if (!this.frame && !this.disposed) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        this.run()
      })
    }
  }

  private onMutations(records: MutationRecord[]) {
    let changed = false
    for (const record of records) {
      const row = this.rowOf(record.target)
      if (row) this.dirty.add(row)
      // Rows came or went; the sheets React redraws are neither.
      changed ||= row !== null || record.target === this.paper || (record.target as Element).classList?.contains('paper-flow')
      for (const node of Array.from(record.removedNodes)) {
        if (node instanceof HTMLElement && this.observed.delete(node)) this.resizes?.unobserve(node)
      }
    }
    if (changed) this.schedule()
  }

  /**
   * A row changed size. A pass already ran this frame for what React changed, so only a
   * change nobody measured (a row rendering for the first time, or again after the rows
   * above it moved, an image, a font) needs one now, before paint.
   */
  private onResize(entries: ResizeObserverEntry[]) {
    let unexplained = false
    for (const entry of entries) {
      const row = entry.target as HTMLElement
      if (this.passes > 0 && this.measured.has(row)) continue
      const geometry = this.geometry.get(row)
      const height = entry.borderBoxSize?.[0]?.blockSize ?? row.offsetHeight
      // RO sizes are layout px, like the cache: the page zoom doesn't scale them.
      if (geometry && this.skipped.get(row) !== true && Math.abs(height - geometry.height - this.pushOf(row)) > 1) {
        this.dirty.add(row)
        unexplained = true
      } else if (!geometry && this.skipped.get(row) !== true) {
        unexplained = true
      }
    }
    if (!unexplained) return
    if (this.passes < MAX_SYNC_PASSES) this.run()
    else this.schedule()
  }

  private readonly onVisibility = (event: Event) => {
    const row = event.target as HTMLElement
    const { skipped } = event as ContentVisibilityAutoStateChangeEvent
    this.skipped.set(row, skipped)
    // A row coming into view may need breaks it never had, or new ones after the rows above it moved.
    if (!skipped) this.schedule()
  }

  /** The row (a child of the flow, or of the paper outside it) that holds `node`. */
  private rowOf(node: Node): HTMLElement | null {
    let el = node instanceof HTMLElement ? node : node.parentElement
    while (el && el !== this.paper && el.parentElement) {
      const parent = el.parentElement
      if (parent.classList.contains('paper-flow')) return el
      if (parent === this.paper) return isRowOfPaper(el) ? el : null
      el = parent
    }
    return null
  }

  private rows(): HTMLElement[] {
    const rows: HTMLElement[] = []
    for (const child of Array.from(this.paper.children)) {
      if (!(child instanceof HTMLElement)) continue
      if (child.classList.contains('paper-flow')) {
        for (const row of Array.from(child.children)) if (row instanceof HTMLElement) rows.push(row)
      } else if (isRowOfPaper(child)) {
        rows.push(child)
      }
    }
    return rows
  }

  /**
   * Whether a row is laid out right now. Only blocks can be skipped; for one the browser
   * hasn't decided on yet, ask whether its contents are visible.
   */
  private isLive(row: HTMLElement): boolean {
    if (!skippable(row)) return true
    const state = this.skipped.get(row)
    if (state !== undefined) return !state
    const child = row.firstElementChild
    // jsdom has no checkVisibility, and lays nothing out anyway.
    return typeof child?.checkVisibility === 'function' ? child.checkVisibility({ contentVisibilityAuto: true }) : true
  }

  private pushOf(row: HTMLElement): number {
    let push = 0
    for (const pageBreak of this.written.get(row)?.values() ?? []) push += pageBreak.push
    return push
  }

  /** One pass: clear the rows to measure, read, compute, then write only what changed. */
  private run() {
    if (this.disposed) return
    this.passes += 1
    if (!this.resetFrame) {
      this.resetFrame = requestAnimationFrame(() => {
        this.resetFrame = 0
        this.passes = 0
        this.measured.clear()
      })
    }
    const paper = this.paper
    const width = getComputedStyle(paper).width
    if (width !== this.width) {
      // The text reflows, so every cached geometry is stale.
      this.width = width
      for (const row of this.rows()) this.dirty.add(row)
    }

    const rows = this.rows()
    const live = rows.map((row) => this.isLive(row))
    const measure = rows.map((row, index) => {
      const stale = this.dirty.has(row) || !this.geometry.has(row) || !skippable(row)
      // A skipped row can't be measured without laying it out; it keeps its breaks until it renders.
      if (stale && !live[index]) this.geometry.delete(row)
      return stale && live[index]
    })
    this.dirty.clear()

    // Writes: rows about to be measured lose their breaks.
    rows.forEach((row, index) => {
      if (measure[index]) this.writeBreaks(row, [])
    })

    // Reads.
    const box = paper.getBoundingClientRect()
    // The page zoom scales client rects; layout values stay in page px.
    const scale = box.width / parseFloat(width)
    if (!scale) return
    const rects = rows.map((row) => row.getBoundingClientRect())
    rows.forEach((row, index) => {
      if (measure[index]) {
        this.geometry.set(row, measureRow(row, rects[index], scale))
        this.measured.add(row)
      }
      if (!this.observed.has(row)) {
        this.observed.add(row)
        this.resizes?.observe(row)
      }
    })
    const pageRows: PageRow<HTMLElement>[] = rows.map((row, index) => ({
      top: (rects[index].top - box.top) / scale,
      height: rects[index].height / scale,
      live: live[index],
      measured: this.geometry.get(row) ?? null,
      applied: this.pushOf(row),
    }))

    // Compute. Lines are read only for a paragraph that crosses a page, and only in a rendered row.
    const layout = layoutPages(pageRows, (unit, index) => {
      const geometry = pageRows[index].measured as Geometry
      if (!geometry.lines.has(unit.el)) {
        if (!live[index]) return null
        geometry.lines.set(unit.el, readLines(unit.el, scale))
      }
      return geometry.lines.get(unit.el) ?? null
    })

    // Writes.
    rows.forEach((row, index) => {
      const next = layout.breaks[index]
      if (next) this.writeBreaks(row, next)
    })
    this.onPages(layout.pages)
  }

  /** Replaces a row's written breaks with `next`, touching only elements that change. */
  private writeBreaks(row: HTMLElement, next: PageBreak<HTMLElement>[]) {
    const before = this.written.get(row)
    if (!before?.size && !next.length) return
    const after = new Map(next.map((pageBreak) => [pageBreak.el, pageBreak]))
    for (const [el, old] of before ?? []) {
      const now = after.get(el)
      if (!now || !sameBreak(old, now)) clearBreak(el)
    }
    for (const [el, now] of after) {
      const old = before?.get(el)
      if (!old || !sameBreak(old, now)) applyBreak(now)
    }
    this.written.set(row, after)
  }
}

/** The paper's own scaffolding isn't page text. */
function isRowOfPaper(el: HTMLElement): boolean {
  return !el.classList.contains('page-sheets') && !el.classList.contains('paper-end') && !el.classList.contains('paper-flow')
}

/**
 * Whether `content-visibility: auto` can skip this row: mirrors document.css, where the
 * streamed block and a block holding a suggestion stay visible.
 */
function skippable(row: HTMLElement): boolean {
  return (
    row.classList.contains('doc-block') && !row.hasAttribute('data-streaming') && !row.querySelector(':scope > .suggestion-row')
  )
}

/** Reads a rendered row's units with its breaks cleared. */
function measureRow(row: HTMLElement, rect: DOMRect, scale: number): Geometry {
  const els = row.classList.contains('doc-block') ? Array.from(row.querySelectorAll<HTMLElement>(BLOCK_UNITS)) : [row]
  const units = els.map((el) => {
    const unit = el.getBoundingClientRect()
    return {
      el,
      offset: (unit.top - rect.top) / scale,
      height: unit.height / scale,
      heading: /^H[1-6]$/.test(el.tagName),
      paragraph: el.tagName === 'P',
    }
  })
  return { units, height: rect.height / scale, lines: new Map() }
}

/** A paragraph's line tops relative to its own top, in page px. */
function readLines(el: HTMLElement, scale: number): Lines | null {
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight)
  if (!lineHeight) return null
  const top = el.getBoundingClientRect().top
  const range = document.createRange()
  range.selectNodeContents(el)
  // Inline boxes sit half a leading below their line box's top.
  const tops = Array.from(range.getClientRects(), (rect) => (rect.top - top) / scale - (lineHeight - rect.height / scale) / 2)
  tops.sort((a, b) => a - b)
  const lines: number[] = []
  for (const line of tops) if (!lines.length || line - lines[lines.length - 1] > lineHeight / 2) lines.push(line)
  return { tops: lines, lineHeight }
}

function sameBreak(a: PageBreak<HTMLElement>, b: PageBreak<HTMLElement>): boolean {
  if (a.kind === 'push' && b.kind === 'push') return a.margin === b.margin
  if (a.kind === 'split' && b.kind === 'split') return a.start === b.start && a.end === b.end
  return false
}

/**
 * A whole-unit push is a top margin (`--page-break`) that adds to the gap the unit already
 * had, so it outweighs any margin it collapses with. A split is an invisible float whose
 * shape covers only the band between the last line that fits and the next page's top
 * margin (`--split-*`), so the paragraph's own DOM, which React owns, is never touched.
 * See document.css.
 */
function applyBreak(pageBreak: PageBreak<HTMLElement>) {
  const { el } = pageBreak
  if (pageBreak.kind === 'push') {
    el.style.setProperty('--page-break', `${pageBreak.margin}px`)
    el.dataset.pageBreak = ''
  } else {
    el.style.setProperty('--split-start', `${pageBreak.start}px`)
    el.style.setProperty('--split-end', `${pageBreak.end}px`)
    el.dataset.pageSplit = ''
  }
}

function clearBreak(el: HTMLElement) {
  for (const name of ['--page-break', '--split-start', '--split-end']) el.style.removeProperty(name)
  delete el.dataset.pageBreak
  delete el.dataset.pageSplit
}
