import { useLayoutEffect, useState, type RefObject } from 'react'

/** US Letter at 96dpi, Docs' 16px grey gap between sheets, and the 1in margins. */
export const PAGE_HEIGHT = 1056
export const PAGE_GAP = 16
export const PAGE_PITCH = PAGE_HEIGHT + PAGE_GAP
const MARGIN = 96

/**
 * What moves to the next page whole, as Docs moves a line that won't fit:
 * questions, images, callouts and cards, each top-level paragraph, heading,
 * table or code block of an answer, each top-level list item, and the
 * composer. Answer wrappers are skipped in favour of their contents.
 */
const UNITS = [
  '.paper > :not(.doc-block, .page-sheets)',
  '.doc-block > :not(:has(> .doc-body))',
  '.doc-body > :not(ul, ol)',
  '.doc-body > :is(ul, ol) > li',
].join(', ')

/**
 * Paginates the print layout: pushes each unit that would cross a page's
 * bottom margin onto the next page (a top padding, so margins stay put) and
 * returns how many sheets to draw. Runs when `content` changes and whenever
 * the paper grows past its sheets, which is when a new break can be needed.
 */
export function usePages(paperRef: RefObject<HTMLElement | null>, content: unknown): number {
  const [pages, setPages] = useState(1)
  useLayoutEffect(() => {
    const paper = paperRef.current
    if (!paper) return
    const update = () => setPages(paginate(paper))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(paper)
    return () => observer.disconnect()
  }, [paperRef, content])
  return pages
}

function paginate(paper: HTMLElement): number {
  for (const el of Array.from(paper.querySelectorAll<HTMLElement>('[data-page-break]'))) {
    el.style.paddingTop = ''
    delete el.dataset.pageBreak
  }
  const box = paper.getBoundingClientRect()
  // The page zoom scales client rects; layout values stay in page px.
  const scale = box.width / parseFloat(getComputedStyle(paper).width)
  if (!scale) return 1
  const measure = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    const top = (rect.top - box.top) / scale
    return { top, bottom: top + rect.height / scale, page: Math.floor(top / PAGE_PITCH) }
  }
  let bottom = 0
  let previous: HTMLElement | null = null
  for (const el of Array.from(paper.querySelectorAll<HTMLElement>(UNITS))) {
    const unit = measure(el)
    const limit = unit.page * PAGE_PITCH + PAGE_HEIGHT - MARGIN
    // Taller than a page's text area: it has to cross a break, so leave it.
    const fits = unit.bottom - unit.top <= PAGE_HEIGHT - 2 * MARGIN
    if (fits && unit.bottom > limit) {
      // Docs keeps a heading with the paragraph after it, so the heading moves too.
      const lead =
        previous && /^H[1-6]$/.test(previous.tagName) && !previous.dataset.pageBreak && measure(previous).page === unit.page
          ? previous
          : el
      const top = measure(lead).top
      const push = (unit.page + 1) * PAGE_PITCH + MARGIN - top
      lead.style.paddingTop = `${parseFloat(getComputedStyle(lead).paddingTop) + push}px`
      lead.dataset.pageBreak = ''
    }
    bottom = Math.max(bottom, measure(el).bottom)
    previous = el
  }
  return Math.floor(bottom / PAGE_PITCH) + 1
}
