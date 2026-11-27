import { useEffect, useRef, useState, type RefObject } from 'react'

import type { OutlineEntry } from './outline'

// The reading line sits 10% down the canvas. The observed area runs from far above
// the canvas down to that line, so a row or heading reports exactly when its top
// (threshold 0) or its bottom (threshold 1) crosses the line, however far one
// scroll moves it.
const READING_LINE = '1000000px 0px -90% 0px'
const EDGES = [0, 1]

/** A row whose top is at or above the reading line; `passed` once its bottom is too. */
type RowAbove = { element: Element; passed: boolean }

/**
 * The key of the outline entry whose section holds the reading line of the
 * canvas around `panel`, or null until the observers first report.
 *
 * Rows (`[data-block]`, the children of `.paper-flow` in `.workspace`) are
 * observed, not headings: a row's box is known even while `content-visibility`
 * skips its contents, so off-screen rows are never laid out. Only the row
 * straddling the line, when it has outline entries, has its headings observed
 * and measured. Rows added later (streamed turns, progressive rows) are picked
 * up as they land. `.paper-end` sits below the composer; once it is on screen
 * after scrolling, the last section is active even if its heading can't reach
 * the line.
 */
export function useReadingSection(
  panel: RefObject<HTMLElement | null>,
  entries: ReadonlyArray<OutlineEntry>,
  open: boolean,
): string | null {
  const [key, setKey] = useState<string | null>(null)
  // Read at report time, so a new outline entry recomputes without re-observing every row.
  const entriesRef = useRef(entries)
  const recomputeRef = useRef(() => {})

  useEffect(() => {
    const root = panel.current?.closest<HTMLElement>('.workspace')
    const flow = root?.querySelector('.paper-flow')
    const end = root?.querySelector('.paper-end')
    if (!open || !root || !flow || typeof IntersectionObserver === 'undefined') return

    const above = new Map<string, RowAbove>()
    let line: number | undefined
    let atEnd = false
    let watched: Element[] = []

    // Headings of the row straddling the line, so one crossing inside a long answer reports.
    const watch = (row: Element | undefined) => {
      const next = row ? Array.from(row.querySelectorAll('h1, h2, h3')) : []
      for (const heading of watched) if (!next.includes(heading)) rows.unobserve(heading)
      for (const heading of next) rows.observe(heading)
      watched = next
    }

    const recompute = () => {
      const entries = entriesRef.current
      if (line === undefined) return
      if (atEnd && above.size > 0) return setKey(entries[entries.length - 1]?.key ?? null)
      // Rows don't overlap, so at most one has its top above the line and its bottom below.
      let straddling: Element | undefined
      for (const row of above.values()) if (!row.passed) straddling = row.element
      const id = straddling?.getAttribute('data-block')
      const own = id ? entries.filter((entry) => entry.blockId === id) : []
      watch(own.length > 0 ? straddling : undefined)
      setKey(readingEntry(entries, above, straddling, own, line)?.key ?? null)
    }
    recomputeRef.current = recompute

    const rows = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          line = record.rootBounds?.bottom ?? line
          const id = (record.target as HTMLElement).dataset.block
          if (id === undefined || line === undefined) continue
          if (!record.isIntersecting) above.delete(id)
          else above.set(id, { element: record.target, passed: record.boundingClientRect.bottom <= line })
        }
        recompute()
      },
      { root, rootMargin: READING_LINE, threshold: EDGES },
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
          if (above.get(node.dataset.block)?.element === node) above.delete(node.dataset.block)
        }
      }
    })

    for (const row of flow.querySelectorAll('[data-block]')) rows.observe(row)
    if (end) ending.observe(end)
    added.observe(flow, { childList: true })
    return () => {
      recomputeRef.current = () => {}
      rows.disconnect()
      ending.disconnect()
      added.disconnect()
    }
  }, [panel, open])

  useEffect(() => {
    entriesRef.current = entries
    recomputeRef.current()
  }, [entries])

  return key
}

/**
 * The entry whose section holds the line. `own` are the entries of the row
 * straddling it: their headings are measured newest first, and only theirs.
 * Otherwise the line sits in a row without entries, or between rows, so the
 * section is the last entry of a row wholly above the line.
 */
function readingEntry(
  entries: ReadonlyArray<OutlineEntry>,
  above: ReadonlyMap<string, RowAbove>,
  straddling: Element | undefined,
  own: ReadonlyArray<OutlineEntry>,
  line: number,
): OutlineEntry | undefined {
  const headings = straddling && own.length > 0 ? straddling.querySelectorAll('h1, h2, h3') : []
  for (const entry of own.toReversed()) {
    // A question's row is its heading, and its top is already above the line.
    if (entry.heading === undefined) return entry
    const heading = headings[entry.heading]
    if (heading && heading.getBoundingClientRect().top <= line) return entry
  }
  return entries.findLast((entry) => above.get(entry.blockId)?.passed) ?? entries[0]
}
