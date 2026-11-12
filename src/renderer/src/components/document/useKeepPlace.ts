import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Keeps what you were reading in place while "Load earlier" adds turns above
 * it. The first row when loading starts is the anchor: however far the new
 * rows push it down, the page scrolls the same amount, from wherever you are
 * by then. The browser's own scroll anchoring is off meanwhile, so the two
 * never both correct. Main ends loading in the snapshot that adds the rows,
 * so one restore sees them. `onRestored` runs after the page moves.
 */
export function useKeepPlace(scrollRef: RefObject<HTMLElement | null>, loading: boolean, onRestored: () => void): void {
  const anchor = useRef<{ row: Element; offset: number } | null>(null)

  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root) return
    // Where a row sits in the page, whatever the scroll position. Read once per load and once per restore.
    const offsetOf = (row: Element) => row.getBoundingClientRect().top + root.scrollTop
    if (loading) {
      const row = root.querySelector('.doc-block')
      if (!row) return
      anchor.current = { row, offset: offsetOf(row) }
      root.style.overflowAnchor = 'none'
    } else if (anchor.current) {
      const { row, offset } = anchor.current
      anchor.current = null
      if (row.isConnected) root.scrollTop += offsetOf(row) - offset
      root.style.overflowAnchor = ''
      onRestored()
    }
  }, [scrollRef, loading, onRestored])
}
