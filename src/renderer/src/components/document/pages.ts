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
  ':scope > :not(.doc-body, :has(> .doc-body))',
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

/** A row's units as they would sit without its breaks, plus lines read so far. */
type Geometry = { units: PageUnit<HTMLElement>[]; height: number; lines: Map<HTMLElement, Lines | null> }

/** Passes one frame may run before the rest waits for the next frame, so a layout that never settles can't hang it. */
const MAX_PASSES_PER_FRAME = 6

/** Passes one ResizeObserver callback runs to let the rows settle. */
const MAX_SETTLE_PASSES = 3

/**
 * Keeps each row's geometry cached and measures a row only when it is rendered and its
 * contents changed, so an off-screen block that `content-visibility` skips is never laid
 * out just to be measured. A row is measured with its breaks in place and the pushes they
 * are known to add taken back out, so a pass only reads and then writes what changed:
 * one layout, the one the frame was going to do. Pagination itself is arithmetic (`layoutPages`).
 */
export class Paginator {
  private readonly geometry = new WeakMap<HTMLElement, Geometry>()
  /** The breaks written into each row, by element. */
  private readonly written = new WeakMap<HTMLElement, Map<HTMLElement, PageBreak<HTMLElement>>>()
  /**
   * Whether `content-visibility` skips a row, from `contentvisibilityautostatechange`, or
   * from the row itself where that event would come too late.
   */
  private readonly skipped = new WeakMap<Element, boolean>()
  /** Rows the last pass saw rendered; one rendering since has never been placed live. */
  private readonly wasLive = new WeakSet<HTMLElement>()
  private readonly dirty = new Set<HTMLElement>()
  private readonly observed = new Set<HTMLElement>()
  private readonly mutations: MutationObserver
  private readonly resizes: ResizeObserver | null
  /**
   * The paper's width in page px (`--paper-width`), fixed on screen, so it's read once rather
   * than every pass. Observing the paper instead would report its every change in height.
   */
  private width: number
  private frame = 0
  /** Passes run this frame; cleared by the next frame. */
  private passes = 0
  private resetFrame = 0
  private disposed = false

  constructor(
    private readonly paper: HTMLElement,
    private readonly onPages: (pages: number) => void,
  ) {
    // Breaks left by an earlier instance (a remount) aren't in this one's books.
    for (const el of Array.from(paper.querySelectorAll<HTMLElement>('[data-page-break], [data-page-split]'))) clearBreak(el)
    this.width = parseFloat(getComputedStyle(paper).width)
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
      // Text measured in a fallback font wraps differently now.
      this.width = parseFloat(getComputedStyle(paper).width)
      for (const row of this.rows()) this.dirty.add(row)
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
   * Runs after layout, so reads here are free. A pass already ran this frame for what React
   * changed, and the breaks it wrote account for their rows' new sizes; only a change no pass
   * planned for (a row rendering for the first time or again, an image, a font) needs one now,
   * before paint.
   */
  private onResize(entries: ResizeObserverEntry[]) {
    let unplanned = false
    for (const entry of entries) {
      const row = entry.target as HTMLElement
      // RO sizes are layout px, like the cache: the page zoom doesn't scale them.
      unplanned = this.unplanned(row, entry.borderBoxSize?.[0]?.blockSize ?? row.offsetHeight, true) || unplanned
    }
    if (unplanned) this.settle()
  }

  /**
   * Whether a row's size is one no pass planned for, marking it to be measured again when
   * its contents must have changed. `fresh` asks the row whether it's skipped rather than
   * trusting the last visibility event: Chromium delivers that event after this frame's
   * ResizeObserver callbacks, so a row coming into view still reads as skipped here.
   */
  private unplanned(row: HTMLElement, height: number, fresh: boolean): boolean {
    if (fresh) this.refreshSkipped(row)
    // A skipped row keeps the size it last rendered at; its breaks wait for it to render.
    if (!this.isLive(row)) return false
    const geometry = this.geometry.get(row)
    // Rendering now but not when the last pass placed it: its breaks may never have been
    // written live, and a paragraph can only be split once its lines can be read.
    if (!geometry || !this.wasLive.has(row)) return true
    if (Math.abs(height - geometry.height - this.pushOf(row)) <= 1) return false
    this.dirty.add(row)
    return true
  }

  /**
   * Passes until the rows stop changing size, each further pass reading the last one's result
   * (the layout the frame runs anyway). ResizeObserver redelivers in the same frame only what
   * sits deeper than the shallowest element any observer delivered, document-wide. Rows are
   * redelivered today only because useFollowBottom observes `.paper-flow` and the scroller
   * above them; looping here keeps pagination from depending on another hook's observer. The
   * "ResizeObserver loop completed with undelivered notifications" that breaks written here
   * log is that `.paper-flow` growing again, which useFollowBottom reads next frame.
   */
  private settle() {
    for (let pass = 0; pass < MAX_SETTLE_PASSES; pass++) {
      if (this.passes >= MAX_PASSES_PER_FRAME) break
      if (!this.run(pass > 0)) return
    }
    this.schedule()
  }

  private readonly onVisibility = (event: Event) => {
    const row = event.target as HTMLElement
    const { skipped } = event as ContentVisibilityAutoStateChangeEvent
    this.skipped.set(row, skipped)
    // A row the observer saw no resize for may still need breaks after the rows above it moved.
    if (!skipped && !this.wasLive.has(row)) this.schedule()
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

  /** Asks the row itself whether it's skipped right now. */
  private refreshSkipped(row: HTMLElement) {
    const child = row.firstElementChild
    // jsdom has no checkVisibility, and lays nothing out anyway.
    if (skippable(row) && typeof child?.checkVisibility === 'function') {
      this.skipped.set(row, !child.checkVisibility({ contentVisibilityAuto: true }))
    }
  }

  /** Whether a row is laid out right now. Only blocks can be skipped. */
  private isLive(row: HTMLElement): boolean {
    if (!skippable(row)) return true
    if (!this.skipped.has(row)) this.refreshSkipped(row)
    return this.skipped.get(row) !== true
  }

  /**
   * How far the breaks written into a row move what follows it. An element React removed
   * (a paragraph that became a table mid-stream) took its break with it.
   */
  private pushOf(row: HTMLElement): number {
    let push = 0
    for (const [el, pageBreak] of this.written.get(row) ?? []) {
      if (el.isConnected && row.contains(el)) push += pageBreak.push
    }
    return push
  }

  /**
   * One pass: read, compute, then write only what changed. With `ifUnplanned`, it stops
   * after the reads unless a row's size is one no pass planned for. Returns whether it wrote.
   */
  private run(ifUnplanned = false): boolean {
    if (this.disposed) return false
    this.passes += 1
    if (!this.resetFrame) {
      this.resetFrame = requestAnimationFrame(() => {
        this.resetFrame = 0
        this.passes = 0
      })
    }
    const paper = this.paper
    const rows = this.rows()
    // Reads. Nothing above wrote, so the first of these is the frame's only layout.
    const box = paper.getBoundingClientRect()
    // The page zoom scales client rects; layout values stay in page px.
    const scale = box.width / this.width
    if (!scale) return false
    const rects = rows.map((row) => row.getBoundingClientRect())
    if (ifUnplanned) {
      // A row the last pass's breaks moved into or out of view, or resized some other way.
      let unplanned = false
      rows.forEach((row, index) => {
        unplanned = this.unplanned(row, rects[index].height / scale, true) || unplanned
      })
      if (!unplanned) return false
    }
    const live = rows.map((row) => this.isLive(row))
    rows.forEach((row, index) => {
      const stale = this.dirty.has(row) || !this.geometry.has(row) || !skippable(row)
      if (stale && live[index]) {
        this.geometry.set(row, measureRow(row, rects[index], scale, this.written.get(row)))
      } else if (stale) {
        // A skipped row can't be measured without laying it out; it keeps its breaks until it renders.
        this.geometry.delete(row)
      }
      if (live[index]) this.wasLive.add(row)
      else this.wasLive.delete(row)
      if (!this.observed.has(row)) {
        this.observed.add(row)
        this.resizes?.observe(row)
      }
    })
    this.dirty.clear()
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
        geometry.lines.set(unit.el, readLines(unit.el, scale, this.written.get(rows[index])?.get(unit.el)))
      }
      return geometry.lines.get(unit.el) ?? null
    })

    // Writes.
    let wrote = false
    rows.forEach((row, index) => {
      const next = layout.breaks[index]
      if (next) wrote = this.writeBreaks(row, next) || wrote
    })
    this.onPages(layout.pages)
    return wrote
  }

  /** Replaces a row's written breaks with `next`, touching only elements that change. Returns whether any did. */
  private writeBreaks(row: HTMLElement, next: PageBreak<HTMLElement>[]): boolean {
    const before = this.written.get(row)
    if (!before?.size && !next.length) return false
    let wrote = false
    const after = new Map<HTMLElement, PageBreak<HTMLElement>>()
    for (const now of next) {
      const old = before?.get(now.el)
      // Within half a pixel, keep what's written, so a pass that reads it back changes nothing.
      if (old && sameBreak(old, now)) {
        after.set(now.el, old)
      } else {
        if (old) clearBreak(now.el)
        applyBreak(now)
        after.set(now.el, now)
        wrote = true
      }
    }
    for (const el of before?.keys() ?? []) {
      if (!after.has(el)) {
        clearBreak(el)
        wrote = true
      }
    }
    this.written.set(row, after)
    return wrote
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

/**
 * Reads a rendered row's units with its breaks in place and takes their known pushes back
 * out: a push moves its own unit and everything after it, a split everything after its
 * band. A row that is one unit carries its push as its own top margin, above its box.
 */
function measureRow(row: HTMLElement, rect: DOMRect, scale: number, written?: Map<HTMLElement, PageBreak<HTMLElement>>): Geometry {
  if (!row.classList.contains('doc-block')) {
    const own = written?.get(row)
    const unit = { el: row, offset: -(own?.push ?? 0), height: rect.height / scale, heading: false, paragraph: false }
    return { units: [unit], height: rect.height / scale, lines: new Map() }
  }
  let moved = 0
  const units = Array.from(row.querySelectorAll<HTMLElement>(BLOCK_UNITS), (el) => {
    const box = el.getBoundingClientRect()
    const own = written?.get(el)
    const unit = {
      el,
      offset: (box.top - rect.top) / scale - moved - (own?.kind === 'push' ? own.push : 0),
      height: box.height / scale - (own?.kind === 'split' ? own.push : 0),
      heading: /^H[1-6]$/.test(el.tagName),
      paragraph: el.tagName === 'P',
    }
    moved += own?.push ?? 0
    return unit
  })
  return { units, height: rect.height / scale - moved, lines: new Map() }
}

/** A paragraph's line tops relative to its own top, in page px, without its split if it has one. */
function readLines(el: HTMLElement, scale: number, written?: PageBreak<HTMLElement>): Lines | null {
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight)
  if (!lineHeight) return null
  const top = el.getBoundingClientRect().top
  const range = document.createRange()
  range.selectNodeContents(el)
  const split = written?.kind === 'split' ? written : null
  const tops = Array.from(range.getClientRects(), (rect) => {
    // Inline boxes sit half a leading below their line box's top.
    const line = (rect.top - top) / scale - (lineHeight - rect.height / scale) / 2
    return split && line >= split.start ? line - split.push : line
  })
  tops.sort((a, b) => a - b)
  const lines: number[] = []
  for (const line of tops) if (!lines.length || line - lines[lines.length - 1] > lineHeight / 2) lines.push(line)
  return { tops: lines, lineHeight }
}

/** Breaks within half a pixel of each other: rewriting one would only add a layout. */
function sameBreak(a: PageBreak<HTMLElement>, b: PageBreak<HTMLElement>): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5
  if (a.kind === 'push' && b.kind === 'push') return near(a.margin, b.margin)
  if (a.kind === 'split' && b.kind === 'split') return near(a.start, b.start) && near(a.end, b.end)
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
