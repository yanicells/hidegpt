import { useEffect, useState, type RefObject } from 'react'

import type { OutlineEntry } from './outline'

// The reading line sits 10% down the canvas. The observed area runs from far above
// the canvas down to that line, so a row or heading changes its intersection
// exactly when it crosses the line, however far one scroll moves it.
const READING_LINE = '1000000px 0px -90% 0px'

/**
 * The key of the outline entry whose section holds the reading line of the
 * canvas around `panel`, or null until the observers first report.
 *
 * Rows (`[data-block]`) are observed, not headings: a row's box is known even
 * while `content-visibility` skips its contents, so off-screen rows are never
 * laid out. Only the row holding the line has its headings observed and
 * measured. Rows added later (streamed turns, progressive rows) are picked up
 * as they land. Once the end of the document is on screen after scrolling,
 * the last section is active even if its heading can't reach the line.
 */
export function useReadingSection(
  panel: RefObject<HTMLElement | null>,
  entries: ReadonlyArray<OutlineEntry>,
  open: boolean,
): string | null {
  const [key, setKey] = useState<string | null>(null)
  useEffect(() => {
    const root = panel.current?.closest<HTMLElement>('.workspace')
    const flow = root?.querySelector('.paper-flow')
    const end = root?.querySelector('.paper-end')
    if (!open || !root || !flow || typeof IntersectionObserver === 'undefined') return

    // Rows at or above the line, by block id. The last of them in outline order holds the line.
    const above = new Map<string, Element>()
    let line: number | undefined
    let atEnd = false
    let watched: Element[] = []

    const recompute = () => {
      if (line === undefined) return
      if (atEnd && above.size > 0) return setKey(entries[entries.length - 1]?.key ?? null)
      const last = entries.findLastIndex((entry) => above.has(entry.blockId))
      const row = last < 0 ? undefined : above.get(entries[last].blockId)
      watchHeadings(row)
      setKey(row ? readingEntry(entries, last, row, line).key : (entries[0]?.key ?? null))
    }

    // Headings inside the row holding the line, so one crossing it reports too.
    const watchHeadings = (row: Element | undefined) => {
      const next = row ? Array.from(row.querySelectorAll('h1, h2, h3')) : []
      for (const heading of watched) if (!next.includes(heading)) rows.unobserve(heading)
      for (const heading of next) rows.observe(heading)
      watched = next
    }

    const rows = new IntersectionObserver(
      (records) => {
        line = records[0]?.rootBounds?.bottom ?? line
        for (const record of records) {
          const id = (record.target as HTMLElement).dataset.block
          if (id === undefined) continue
          if (record.isIntersecting) above.set(id, record.target)
          else above.delete(id)
        }
        recompute()
      },
      { root, rootMargin: READING_LINE },
    )
    const ending = new IntersectionObserver(
      (records) => {
        atEnd = records[records.length - 1]?.isIntersecting ?? atEnd
        recompute()
      },
      { root },
    )
    // Rows are the flow's children; this fires once per added row, not per streamed chunk.
    const added = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes)
          if (node instanceof HTMLElement && node.dataset.block) rows.observe(node)
        for (const node of mutation.removedNodes) {
          if (!(node instanceof HTMLElement) || !node.dataset.block) continue
          rows.unobserve(node)
          if (above.get(node.dataset.block) === node) above.delete(node.dataset.block)
        }
      }
    })

    for (const row of flow.querySelectorAll('[data-block]')) rows.observe(row)
    if (end) ending.observe(end)
    added.observe(flow, { childList: true })
    return () => {
      rows.disconnect()
      ending.disconnect()
      added.disconnect()
    }
  }, [panel, entries, open])
  return key
}

/**
 * The entry whose section holds the line, given that `row` holds it and
 * `entries[last]` is that row's last entry. Rows before it are wholly above
 * the line, so only this row's headings are measured, newest first.
 */
function readingEntry(entries: ReadonlyArray<OutlineEntry>, last: number, row: Element, line: number): OutlineEntry {
  const headings = row.querySelectorAll('h1, h2, h3')
  for (let index = last; index >= 0; index--) {
    const entry = entries[index]
    if (entry.blockId !== row.getAttribute('data-block') || entry.heading === undefined) return entry
    const heading = headings[entry.heading]
    if (heading && heading.getBoundingClientRect().top <= line) return entry
  }
  return entries[0]
}
