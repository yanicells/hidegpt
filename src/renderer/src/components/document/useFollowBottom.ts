import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

// How close to the end still counts as "at the bottom".
const NEAR_END = '0px 0px 120px 0px'

/**
 * Keeps the page at the bottom while an answer streams, if you are there,
 * without reading layout on every delta. A ResizeObserver scrolls once the
 * browser has laid out new text, and an IntersectionObserver on `end` tracks
 * whether you are near the bottom. A new question of yours pulls the page
 * down; another document starts at the top. Returns `release`, for jumps that
 * move the page on purpose.
 */
export function useFollowBottom({
  scrollRef,
  contentRef,
  endRef,
  threadId,
  askedId,
}: {
  scrollRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  endRef: RefObject<HTMLElement | null>
  threadId: string
  /** The newest block's id when it is your question, else null. */
  askedId: string | null
}): { release: () => void } {
  const follow = useRef(false)
  const seen = useRef({ threadId, askedId })

  // Layout effects, so the flag is set before the browser lays out and the observers run.
  useLayoutEffect(() => {
    const before = seen.current
    seen.current = { threadId, askedId }
    if (before.threadId !== threadId) {
      follow.current = false
      if (scrollRef.current) scrollRef.current.scrollTop = 0
    } else if (askedId !== null && askedId !== before.askedId) {
      follow.current = true
    }
  }, [threadId, askedId, scrollRef])

  useLayoutEffect(() => {
    const root = scrollRef.current
    const content = contentRef.current
    const end = endRef.current
    if (!root || !content || !end || typeof ResizeObserver === 'undefined' || typeof IntersectionObserver === 'undefined') return
    // Layout is fresh inside the callback, so reading scrollHeight costs nothing extra.
    const grew = new ResizeObserver(() => {
      if (follow.current) root.scrollTop = root.scrollHeight
    })
    const near = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) follow.current = entry.isIntersecting
      },
      { root, rootMargin: NEAR_END },
    )
    grew.observe(content)
    near.observe(end)
    return () => {
      grew.disconnect()
      near.disconnect()
    }
  }, [scrollRef, contentRef, endRef])

  const release = useCallback(() => {
    follow.current = false
  }, [])
  return { release }
}
