import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

// How close to the end still counts as "at the bottom".
const NEAR_END = '0px 0px 120px 0px'

/**
 * Keeps the page at the bottom while an answer streams, if you are there,
 * without reading layout on every delta. A ResizeObserver scrolls once the
 * browser has laid out new text, and an IntersectionObserver on `end` tracks
 * whether you are near the bottom. A document opens at the top and follows
 * only once you scroll to its end or ask a question, so a resize or a late
 * image never pulls it down. Mount one per document (keyed by thread), so
 * this state starts fresh. Returns `release`, for jumps that move the page on
 * purpose.
 */
export function useFollowBottom({
  scrollRef,
  contentRef,
  endRef,
  askedId,
}: {
  scrollRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  endRef: RefObject<HTMLElement | null>
  /** The newest block's id when it is your question, else null. */
  askedId: string | null
}): { release: () => void } {
  const follow = useRef(false)
  // You have scrolled or asked since the document opened.
  const engaged = useRef(false)
  // The end marker's last reported state.
  const nearEnd = useRef(false)
  const seenAsked = useRef(askedId)

  // Layout effects, so the flag is set before the browser lays out and the observers run.
  useLayoutEffect(() => {
    if (askedId !== null && askedId !== seenAsked.current) {
      follow.current = true
      engaged.current = true
    }
    seenAsked.current = askedId
  }, [askedId])

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
        if (!entry) return
        nearEnd.current = entry.isIntersecting
        if (engaged.current) follow.current = entry.isIntersecting
      },
      { root, rootMargin: NEAR_END },
    )
    // The observer decides where you are; your first scroll only starts listening to it.
    const scrolled = () => {
      if (engaged.current) return
      engaged.current = true
      follow.current = nearEnd.current
    }
    grew.observe(content)
    near.observe(end)
    root.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      grew.disconnect()
      near.disconnect()
      root.removeEventListener('scroll', scrolled)
    }
  }, [scrollRef, contentRef, endRef])

  const release = useCallback(() => {
    follow.current = false
  }, [])
  return { release }
}
