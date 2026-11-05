import { useLayoutEffect, useState, type RefObject } from 'react'

/** US Letter at 96dpi, Docs' 16px grey gap between sheets, and the 1in margins. */
export const PAGE_HEIGHT = 1056
const PAGE_GAP = 16
export const PAGE_PITCH = PAGE_HEIGHT + PAGE_GAP
const MARGIN = 96

/**
 * What paginates: questions, images, callouts, each top-level paragraph,
 * heading, table or code block of an answer, each top-level list item, and
 * the composer. Answer wrappers are skipped in favour of their contents, and
 * suggestion cards sit in the margin, outside the pages.
 */
const UNITS = [
  '.paper > :not(.doc-block, .page-sheets)',
  '.doc-block > :not(:has(> .doc-body), .suggestion)',
  '.doc-body > :not(ul, ol)',
  '.doc-body > :is(ul, ol) > li',
].join(', ')

/** Docs' "prevent single lines": a split paragraph keeps at least two lines on each page. */
const MIN_LINES = 2

/**
 * Paginates the print layout and returns how many sheets to draw. A
 * paragraph that crosses a page's bottom margin breaks between its lines;
 * anything else moves to the next page whole. Text edits (streaming
 * included) and resizes are coalesced into at most one pass per frame.
 */
export function usePages(paperRef: RefObject<HTMLElement | null>): number {
  const [pages, setPages] = useState(1)
  useLayoutEffect(() => {
    const paper = paperRef.current
    if (!paper) return
    let frame = 0
    const update = () => {
      frame = 0
      setPages(paginate(paper))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    // Our own break writes are attribute changes, so they don't retrigger this.
    const mutations = new MutationObserver(schedule)
    mutations.observe(paper, { childList: true, subtree: true, characterData: true })
    const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resizes?.observe(paper)
    void document.fonts?.ready.then(schedule)
    return () => {
      cancelAnimationFrame(frame)
      mutations.disconnect()
      resizes?.disconnect()
    }
  }, [paperRef])
  return pages
}

type Unit = { el: HTMLElement; top: number; height: number }
type PageBreak =
  | { kind: 'push'; el: HTMLElement; margin: number }
  | { kind: 'split'; el: HTMLElement; start: number; end: number }

/**
 * One layout read, then all writes: units are measured once with the old
 * breaks cleared, and each break shifts everything after it by the same
 * amount. A whole-unit push is a top margin (`--page-break`) that adds to the
 * gap the unit already had, so it outweighs any margin it collapses with. A
 * split is an invisible float whose shape covers only the band between the
 * last line that fits and the next page's top margin (`--split-*`), so the
 * paragraph's own DOM, which React owns, is never touched. See document.css.
 */
function paginate(paper: HTMLElement): number {
  for (const el of Array.from(paper.querySelectorAll<HTMLElement>('[data-page-break], [data-page-split]'))) {
    for (const name of ['--page-break', '--split-start', '--split-end']) el.style.removeProperty(name)
    delete el.dataset.pageBreak
    delete el.dataset.pageSplit
  }
  const box = paper.getBoundingClientRect()
  // The page zoom scales client rects; layout values stay in page px.
  const scale = box.width / parseFloat(getComputedStyle(paper).width)
  if (!scale) return 1
  const toPage = (y: number) => (y - box.top) / scale
  const units: Unit[] = Array.from(paper.querySelectorAll<HTMLElement>(UNITS), (el) => {
    const rect = el.getBoundingClientRect()
    return { el, top: toPage(rect.top), height: rect.height / scale }
  })
  // Narrow windows keep suggestion cards in the flow; their space sits between units.
  const cardBottoms = Array.from(paper.querySelectorAll<HTMLElement>('.suggestion'))
    .filter((el) => getComputedStyle(el).position !== 'absolute')
    .map((el) => toPage(el.getBoundingClientRect().bottom))

  const breaks: PageBreak[] = []
  let shift = 0
  let bottom = 0
  units.forEach((unit, index) => {
    const top = unit.top + shift
    const page = Math.floor(top / PAGE_PITCH)
    const limit = page * PAGE_PITCH + PAGE_HEIGHT - MARGIN
    const nextTop = (page + 1) * PAGE_PITCH + MARGIN
    if (top + unit.height > limit) {
      const split = unit.el.tagName === 'P' ? splitLine(unit.el, toPage, scale, shift, limit) : null
      if (split !== null) {
        const push = nextTop - (split + shift)
        // The band starts a pixel into the line so rounding can't catch the line above.
        breaks.push({ kind: 'split', el: unit.el, start: split - unit.top + 1, end: split - unit.top + push })
        shift += push
      } else if (unit.height <= PAGE_HEIGHT - 2 * MARGIN) {
        // Docs keeps a heading with the paragraph after it, so the heading moves too.
        const previous = units[index - 1]
        const keep =
          previous &&
          /^H[1-6]$/.test(previous.el.tagName) &&
          breaks.at(-1)?.el !== previous.el &&
          Math.floor((previous.top + shift) / PAGE_PITCH) === page
        const leadIndex = keep ? index - 1 : index
        const lead = units[leadIndex]
        const above = units[leadIndex - 1]
        const aboveBottom = Math.max(
          above ? above.top + above.height : MARGIN,
          ...cardBottoms.filter((bottom) => bottom <= lead.top),
        )
        const gap = lead.top - aboveBottom
        const push = nextTop - (lead.top + shift)
        breaks.push({ kind: 'push', el: lead.el, margin: gap + push })
        shift += push
      }
      // Otherwise it is taller than a page's text area and has to cross the break.
    }
    bottom = Math.max(bottom, unit.top + shift + unit.height)
  })

  for (const pageBreak of breaks) {
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
  return Math.floor(bottom / PAGE_PITCH) + 1
}

/**
 * Where a paragraph crossing `limit` should break: the top of its first line
 * that doesn't fit, in page px before `shift`, or null when either side
 * would keep fewer than MIN_LINES lines.
 */
function splitLine(
  el: HTMLElement,
  toPage: (y: number) => number,
  scale: number,
  shift: number,
  limit: number,
): number | null {
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight)
  if (!lineHeight) return null
  const range = document.createRange()
  range.selectNodeContents(el)
  // Inline boxes sit half a leading below their line box's top.
  const tops = Array.from(range.getClientRects(), (rect) => toPage(rect.top) - (lineHeight - rect.height / scale) / 2)
  tops.sort((a, b) => a - b)
  const lines: number[] = []
  for (const top of tops) if (!lines.length || top - lines[lines.length - 1] > lineHeight / 2) lines.push(top)
  const first = lines.findIndex((top) => top + shift + lineHeight > limit)
  const at = Math.min(first, lines.length - MIN_LINES)
  return first >= 0 && at >= MIN_LINES ? lines[at] : null
}
