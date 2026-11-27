// Adapted from T3 Code (apps/web/src/components/search/ProjectContentSearchDialog.tsx, its load-more
// sentinel, and the scroller-rooted observer in apps/web/src/components/Sidebar.logic.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { useCallback, useState } from 'react'

/** Cards or rows Home mounts at first. */
export const FIRST_WINDOW = 60
/** Cards or rows added each time the end of the list comes near. */
export const NEXT_WINDOW = 120
/** How far below the visible part of Home the end may be before more mount. */
const LOAD_AHEAD_PX = 1000

/**
 * How many of Home's documents to mount, and a ref for a sentinel after the
 * last one. No virtualizer: mounted cards stay mounted, so scrolling and
 * layout behave as with the whole list. The window goes back to the first 60
 * when `resetKey` (the filter, sort and view) changes. Without an
 * IntersectionObserver everything mounts.
 *
 * Give the sentinel `key={count}`: each batch then observes it afresh, and a
 * new observer reports at once, so a sentinel still in range mounts the next
 * batch too.
 */
export function useMountWindow(resetKey: string): {
  count: number
  sentinelRef: (sentinel: HTMLElement | null) => (() => void) | undefined
} {
  const [count, setCount] = useState(FIRST_WINDOW)
  const [countFor, setCountFor] = useState(resetKey)
  if (countFor !== resetKey) {
    setCountFor(resetKey)
    setCount(FIRST_WINDOW)
  }
  const sentinelRef = useCallback((sentinel: HTMLElement | null) => {
    if (!sentinel) return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setCount((current) => current + NEXT_WINDOW)
      },
      // Home scrolls inside `.home`, which would clip a viewport-rooted margin.
      { root: sentinel.closest('.home'), rootMargin: `0px 0px ${LOAD_AHEAD_PX}px 0px` },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])
  return { count: typeof IntersectionObserver === 'undefined' ? Infinity : count, sentinelRef }
}
