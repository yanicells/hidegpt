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

/**
 * Where a row sat after the last pass and its writes, in page px from the paper's top, and
 * the row before it then: a new row above it means its place can't be shifted, only read.
 */
type Place = { top: number; height: number; after: HTMLElement | null }

/** How far a predicted place may be off before every row is read again. */
const PLACE_TOLERANCE = 0.5

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
 *
 * Box reads are limited too: a pass reads only the rows it measures, rows something reported
 * (a resize, a visibility change, a new neighbour above), and the last row. Every other row
 * keeps its place from the last pass, moved by how much the rows read above it grew, and by
 * the breaks that pass wrote. The last row checks that prediction; when it is off, every row
 * is read again, so a change nothing reported costs one slow pass and never a wrong break.
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
  /** Each row's place after the last pass; replaced whole by every pass. */
  private places = new Map<HTMLElement, Place>()
  /** Rows reported moved or resized since the last pass, which read their box again. */
  private readonly moved = new Set<HTMLElement>()
  /** The rows in order, until a row comes or goes. */
  private rowList: HTMLElement[] | null = null
  /** `skippable(row)`, until a mutation in the row. */
  private readonly canSkip = new WeakMap<HTMLElement, boolean>()
  private readonly mutations: MutationObserver
  private readonly resizes: ResizeObserver | null
  /**
   * The paper's width in page px (`--paper-width`), fixed on screen, so it's read once rather
   * than every pass. Observing the paper instead would report its every change in height.
   */
  private width: number
  /** The paper's client width at the last pass: it changes with the zoom. */
  private clientWidth = 0
  private frame = 0
  /** Passes run this frame; cleared by the next frame. */
  private passes = 0
  private resetFrame = 0
  private disposed = false

  private readonly paper: HTMLElement
  private readonly onPages: (pages: number) => void

  constructor(paper: HTMLElement, onPages: (pages: number) => void) {
    this.paper = paper
    this.onPages = onPages
    // Breaks left by an earlier instance (a remount) aren't in this one's books.
    for (const el of Array.from(paper.querySelectorAll<HTMLElement>('[data-page-break], [data-page-split]')))
      clearBreak(el)
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
    this.resizes =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => this.onResize(entries))
    paper.addEventListener('contentvisibilityautostatechange', this.onVisibility, true)
    void document.fonts?.ready.then(() => {
      if (this.disposed) return
      // Text measured in a fallback font wraps differently now.
      this.width = parseFloat(getComputedStyle(paper).width)
      for (const row of this.rows()) this.dirty.add(row)
      this.onFonts()
    })
    document.fonts?.addEventListener('loadingdone', this.onFonts)
    this.run()
  }

  /** A font that loaded moves text with no mutation: place every row again. Rows it resized report themselves. */
  private readonly onFonts = () => {
    if (this.disposed) return
    this.places = new Map()
    this.schedule()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    cancelAnimationFrame(this.resetFrame)
    this.mutations.disconnect()
    this.resizes?.disconnect()
    this.paper.removeEventListener('contentvisibilityautostatechange', this.onVisibility, true)
    document.fonts?.removeEventListener('loadingdone', this.onFonts)
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
      if (row) {
        this.dirty.add(row)
        this.canSkip.delete(row)
      }
      // Rows came or went; the sheets React redraws are neither.
      const holder = record.target === this.paper || (record.target as Element).classList?.contains('paper-flow')
      if (holder && record.type === 'childList') this.rowList = null
      changed ||= row !== null || holder
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
      const height = entry.borderBoxSize?.[0]?.blockSize ?? row.offsetHeight
      // A size the last pass's writes predicted moves nothing below the row.
      const place = this.places.get(row)
      if (!place || Math.abs(height - place.height) > PLACE_TOLERANCE) this.moved.add(row)
      unplanned = this.unplanned(row, height, true) || unplanned
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
    if (!geometry) return true
    // Breaks inside a block add to its box; a row that is one unit carries its break as its
    // own top margin, outside the box.
    const inside = row.classList.contains('doc-block') ? this.pushOf(row) : 0
    // Its contents changed with no mutation (an image loaded, the wrapping changed), maybe
    // while it was skipped: measure it again.
    if (Math.abs(height - geometry.height - inside) > 1) this.dirty.add(row)
    // Rendering now but not when the last pass placed it: its breaks may never have been
    // written live, and a paragraph can only be split once its lines can be read.
    return this.dirty.has(row) || !this.wasLive.has(row)
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
    this.moved.add(row)
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
    if (this.rowList) return this.rowList
    const rows: HTMLElement[] = []
    for (const child of Array.from(this.paper.children)) {
      if (!(child instanceof HTMLElement)) continue
      if (child.classList.contains('paper-flow')) {
        for (const row of Array.from(child.children)) if (row instanceof HTMLElement) rows.push(row)
      } else if (isRowOfPaper(child)) {
        rows.push(child)
      }
    }
    this.rowList = rows
    return rows
  }

  private skips(row: HTMLElement): boolean {
    let skips = this.canSkip.get(row)
    if (skips === undefined) {
      skips = skippable(row)
      this.canSkip.set(row, skips)
    }
    return skips
  }

  /** Asks the row itself whether it's skipped right now. */
  private refreshSkipped(row: HTMLElement) {
    const child = row.firstElementChild
    // jsdom has no checkVisibility, and lays nothing out anyway.
    if (this.skips(row) && typeof child?.checkVisibility === 'function') {
      this.skipped.set(row, !child.checkVisibility({ contentVisibilityAuto: true }))
    }
  }

  /** Whether a row is laid out right now. Only blocks can be skipped. */
  private isLive(row: HTMLElement): boolean {
    if (!this.skips(row)) return true
    if (!this.skipped.has(row)) this.refreshSkipped(row)
    return this.skipped.get(row) !== true
  }

  /** Forgets the breaks of elements no longer in `row`, clearing them off any that moved elsewhere. */
  private dropLeft(row: HTMLElement) {
    const written = this.written.get(row)
    for (const el of written?.keys() ?? []) {
      if (row.contains(el)) continue
      clearBreak(el)
      written!.delete(el)
    }
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
    // An element leaves a row only by a mutation in it. One React moved to another row takes
    // its break off before that row measures it; nothing has been read yet, so this costs nothing.
    for (const row of this.dirty) this.dropLeft(row)
    // Reads. The first of these is the frame's only layout.
    const box = paper.getBoundingClientRect()
    // The page zoom scales client rects; layout values stay in page px.
    const scale = box.width / this.width
    if (!scale) return false
    if (box.width !== this.clientWidth) {
      // Text lays out again at a new zoom or width, so no place can be trusted.
      this.clientWidth = box.width
      this.places = new Map()
    }
    let places: Place[] | undefined
    if (ifUnplanned) {
      // A row the last pass's breaks moved into or out of view, or resized some other way.
      places = this.locate(rows, box)
      let unplanned = false
      rows.forEach((row, index) => {
        unplanned = this.unplanned(row, places![index].height, true) || unplanned
      })
      if (!unplanned) return false
    }
    const live = rows.map((row) => this.isLive(row))
    const measure = rows.map((row, index) => {
      const stale = this.dirty.has(row) || !this.geometry.has(row) || !this.skips(row)
      // A skipped row can't be measured without laying it out; it keeps its breaks until it renders.
      if (stale && !live[index]) this.geometry.delete(row)
      return stale && live[index]
    })
    places ??= this.locate(rows, box, (index) => measure[index] || this.dirty.has(rows[index]))
    rows.forEach((row, index) => {
      if (measure[index]) {
        this.geometry.set(row, measureRow(row, places![index], box.top, scale, this.written.get(row)))
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
      top: places![index].top,
      height: places![index].height,
      live: live[index],
      measured: this.geometry.get(row) ?? null,
      applied: this.pushOf(row),
      written: this.written.get(row),
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

    // Writes. A live row's new breaks move what follows it by their change in push (inside a
    // block's box, or a one-unit row's own top margin), so the places follow without a read.
    let wrote = false
    let shift = 0
    rows.forEach((row, index) => {
      const place = places![index]
      place.top += shift
      const next = layout.breaks[index]
      if (!next || !this.writeBreaks(row, next)) return
      wrote = true
      if (!live[index]) return
      const push = this.pushOf(row) - pageRows[index].applied
      if (row.classList.contains('doc-block')) place.height += push
      else place.top += push
      shift += push
    })
    this.onPages(layout.pages)
    return wrote
  }

  /**
   * Every row's place now. Without `read`, reads every row. With it, reads the rows it
   * names, rows reported moved, rows with no place or a new row above them, and the last
   * row; the rest keep their place, moved by how much the rows read above them grew. The
   * last row checks that guess and, off by more than PLACE_TOLERANCE, every row is read.
   */
  private locate(rows: HTMLElement[], box: DOMRect, read?: (index: number) => boolean): Place[] {
    const scale = box.width / this.width
    const places: Place[] = []
    // How far the rows below the last one read have moved; null after a row with no place.
    let delta: number | null = 0
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      const after = index > 0 ? rows[index - 1] : null
      const old = this.places.get(row)
      const guess = old && old.after === after && delta !== null ? old.top + delta : null
      const last = index === rows.length - 1
      if (read && old && guess !== null && !last && !read(index) && !this.moved.has(row)) {
        places.push({ top: guess, height: old.height, after })
        continue
      }
      const rect = row.getBoundingClientRect()
      const place = { top: (rect.top - box.top) / scale, height: rect.height / scale, after }
      if (read && last && (guess === null || Math.abs(place.top - guess) > PLACE_TOLERANCE)) {
        return this.locate(rows, box)
      }
      places.push(place)
      delta = old ? place.top + place.height - (old.top + old.height) : null
    }
    this.moved.clear()
    this.places = new Map(rows.map((row, index) => [row, places[index]]))
    return places
  }

  /** Replaces a row's written breaks with `next`, touching only elements that change. Returns whether any did. */
  private writeBreaks(row: HTMLElement, next: PageBreak<HTMLElement>[]): boolean {
    const before = this.written.get(row)
    if (!before?.size && !next.length) return false
    let wrote = false
    const after = new Map<HTMLElement, PageBreak<HTMLElement>>()
    for (const now of next) {
      const old = before?.get(now.el)
      after.set(now.el, now)
      // layoutPages hands back the written break when the new one is within half a pixel of it.
      if (old === now) continue
      if (old) clearBreak(now.el)
      applyBreak(now)
      wrote = true
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
  return (
    !el.classList.contains('page-sheets') && !el.classList.contains('paper-end') && !el.classList.contains('paper-flow')
  )
}

/**
 * Whether `content-visibility: auto` can skip this row: mirrors document.css, where the
 * streamed block and a block holding a suggestion stay visible.
 */
function skippable(row: HTMLElement): boolean {
  return (
    row.classList.contains('doc-block') &&
    !row.hasAttribute('data-streaming') &&
    !row.querySelector(':scope > .suggestion-row')
  )
}

/**
 * Reads a rendered row's units with its breaks in place and takes their known pushes back
 * out: a push moves its own unit and everything after it, a split everything after its
 * band. A row that is one unit carries its push as its own top margin, above its box.
 */
function measureRow(
  row: HTMLElement,
  place: Place,
  paperTop: number,
  scale: number,
  written?: Map<HTMLElement, PageBreak<HTMLElement>>,
): Geometry {
  if (!row.classList.contains('doc-block')) {
    const own = written?.get(row)
    const unit = { el: row, offset: -(own?.push ?? 0), height: place.height, heading: false, paragraph: false }
    return { units: [unit], height: place.height, lines: new Map() }
  }
  let moved = 0
  const units = Array.from(row.querySelectorAll<HTMLElement>(BLOCK_UNITS), (el) => {
    const box = el.getBoundingClientRect()
    const own = written?.get(el)
    const unit = {
      el,
      offset: (box.top - paperTop) / scale - place.top - moved - (own?.kind === 'push' ? own.push : 0),
      height: box.height / scale - (own?.kind === 'split' ? own.push : 0),
      heading: /^H[1-6]$/.test(el.tagName),
      paragraph: el.tagName === 'P',
    }
    moved += own?.push ?? 0
    return unit
  })
  return { units, height: place.height - moved, lines: new Map() }
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
