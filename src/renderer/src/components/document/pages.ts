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
 * returns how many sheets to draw. Text edits (streaming included) and
 * resizes are coalesced into at most one pass per frame.
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
    // Our own padding writes are attribute changes, so they don't retrigger this.
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

type PageBreak = { el: HTMLElement; push: number }

/**
 * One layout read, then all writes: units are measured once with the old
 * breaks cleared, and each push shifts everything after it by the same amount.
 */
function paginate(paper: HTMLElement): number {
  for (const el of Array.from(paper.querySelectorAll<HTMLElement>('[data-page-break]'))) {
    el.style.paddingTop = ''
    delete el.dataset.pageBreak
  }
  const box = paper.getBoundingClientRect()
  // The page zoom scales client rects; layout values stay in page px.
  const scale = box.width / parseFloat(getComputedStyle(paper).width)
  if (!scale) return 1
  const units = Array.from(paper.querySelectorAll<HTMLElement>(UNITS), (el) => {
    const rect = el.getBoundingClientRect()
    return { el, top: (rect.top - box.top) / scale, height: rect.height / scale }
  })

  const breaks: PageBreak[] = []
  let shift = 0
  let bottom = 0
  units.forEach((unit, index) => {
    const top = unit.top + shift
    const page = Math.floor(top / PAGE_PITCH)
    const limit = page * PAGE_PITCH + PAGE_HEIGHT - MARGIN
    // Taller than a page's text area: it has to cross a break, so leave it.
    const fits = unit.height <= PAGE_HEIGHT - 2 * MARGIN
    if (fits && top + unit.height > limit) {
      // Docs keeps a heading with the paragraph after it, so the heading moves too.
      const previous = units[index - 1]
      const keep =
        previous &&
        /^H[1-6]$/.test(previous.el.tagName) &&
        breaks.at(-1)?.el !== previous.el &&
        Math.floor((previous.top + shift) / PAGE_PITCH) === page
      const lead = keep ? previous : unit
      const push = (page + 1) * PAGE_PITCH + MARGIN - (lead.top + shift)
      breaks.push({ el: lead.el, push })
      shift += push
    }
    bottom = Math.max(bottom, unit.top + shift + unit.height)
  })

  const paddings = breaks.map(({ el }) => parseFloat(getComputedStyle(el).paddingTop))
  breaks.forEach(({ el, push }, index) => {
    el.style.paddingTop = `${paddings[index] + push}px`
    el.dataset.pageBreak = ''
  })
  return Math.floor(bottom / PAGE_PITCH) + 1
}
