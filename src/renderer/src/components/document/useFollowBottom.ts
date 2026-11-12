// Upward-input release adapted from T3 Code (apps/web/src/components/chat/timelineViewport.ts) at commit 8a14762c.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

// How close to the end still counts as "at the bottom".
const NEAR_END = '0px 0px 120px 0px'
const UP_KEYS = new Set(['PageUp', 'Home', 'ArrowUp'])

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

/** Whether moving up from `target` scrolls the page, not a box inside it (a long callout, the tabs list). */
function movesPageUp(target: EventTarget | null, root: HTMLElement): boolean {
  for (let element = target instanceof Element ? target : null; element && element !== root; element = element.parentElement) {
    if (element.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(element).overflowY)) return false
  }
  return root.scrollTop > 0
}

/**
 * Keeps the page at the bottom while an answer streams, if you are there,
 * without reading layout on every delta. A ResizeObserver on `content` (which
 * has no minimum height, so a short document grows it too) scrolls once the
 * browser has laid out new text, and an IntersectionObserver on `end` tracks
 * whether you are near the bottom. A document opens at the top and follows
 * only once you scroll to its end or ask a question, so a resize or a late
 * image never pulls it down. Moving up (wheel, keys, the scrollbar) lets go at
 * once, before that frame's resize could pull the page back; it follows again
 * once you return to the end. Mount one per document (keyed by thread), so
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
    const leave = () => {
      engaged.current = true
      follow.current = false
    }
    // Input events only, so these layout reads never run per delta.
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && movesPageUp(event.target, root)) leave()
    }
    const key = (event: KeyboardEvent) => {
      const up = UP_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)
      if (up && !isEditable(event.target) && movesPageUp(event.target, root)) leave()
    }
    // A scrollbar drag sends no wheel events; it is the only press whose target is the scroller itself.
    let onScrollbar = false
    const press = (event: PointerEvent) => {
      onScrollbar = event.target === root
      if (onScrollbar) leave()
    }
    // Letting go of the scrollbar at the end follows again.
    const lift = () => {
      if (onScrollbar) follow.current = nearEnd.current
      onScrollbar = false
    }
    grew.observe(content)
    near.observe(end)
    root.addEventListener('scroll', scrolled, { passive: true })
    root.addEventListener('wheel', wheel, { passive: true })
    root.addEventListener('pointerdown', press, { passive: true })
    window.addEventListener('pointerup', lift, { passive: true })
    window.addEventListener('keydown', key)
    return () => {
      grew.disconnect()
      near.disconnect()
      root.removeEventListener('scroll', scrolled)
      root.removeEventListener('wheel', wheel)
      root.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', lift)
      window.removeEventListener('keydown', key)
    }
  }, [scrollRef, contentRef, endRef])

  const release = useCallback(() => {
    follow.current = false
  }, [])
  return { release }
}
