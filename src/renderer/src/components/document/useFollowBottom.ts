// Upward-input release and the upward-scroll detector adapted from T3 Code
// (apps/web/src/components/chat/timelineViewport.ts and timelineScrollTarget.ts) at commit 8a14762c.
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
 * Returns a check, called on each scroll event, for whether the page moved up
 * by more than a pixel since the last one. A shrinking scroll range (a shorter
 * document, a taller window) clamps the position without anyone scrolling, so
 * it only resets the baseline; sub-pixel steps add up. T3 compares heights;
 * this compares the range, so a taller window is not read as a scroll. Starts
 * at the top, where every document opens.
 */
function upwardScrollDetector(root: HTMLElement): () => boolean {
  let baseline = { top: 0, range: 0 }
  return () => {
    const next = { top: root.scrollTop, range: root.scrollHeight - root.clientHeight }
    if (next.range < baseline.range || next.top > baseline.top) {
      baseline = next
      return false
    }
    if (next.top < baseline.top - 1) {
      baseline = next
      return true
    }
    baseline = { top: baseline.top, range: next.range }
    return false
  }
}

/**
 * Keeps the page at the bottom while an answer streams, if you are there,
 * without reading layout on every delta. A ResizeObserver on `content` (which
 * has no minimum height, so a short document grows it too) and on the scroller
 * (a shorter window) scrolls once the browser has laid out, and an
 * IntersectionObserver on `end` tracks whether you are near the bottom. A
 * document opens at the top and follows only once you scroll to its end or ask
 * a question, so a resize or a late image never pulls it down.
 *
 * Moving up lets go at once, before that frame's resize could pull the page
 * back: wheel, keys and a press on the scrollbar as they happen, and any other
 * upward scroll (dragging a selection, focus moving to a link above) from the
 * scroll event, which the browser sends before resize callbacks. It follows
 * again once you leave the end and come back. Mount one per document (keyed by
 * thread), so this state starts fresh. Returns `release`, for moves made on
 * purpose (a jump, keeping your place after "Load earlier").
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
  // You have scrolled, asked or jumped since the document opened.
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
    const leave = () => {
      engaged.current = true
      follow.current = false
    }
    // Scroll events come just before the frame's layout, so these reads add none.
    const movedUp = upwardScrollDetector(root)
    const scrolled = () => {
      if (movedUp()) leave()
      else if (!engaged.current) {
        // The observer decides where you are; your first scroll only starts listening to it.
        engaged.current = true
        follow.current = nearEnd.current
      }
    }
    // Input events only, so these layout reads never run per delta. Ctrl+wheel zooms.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && event.deltaY < 0 && movesPageUp(event.target, root)) leave()
    }
    // Keys count from the page or from nothing focused, as in T3: one pressed on a toolbar
    // button does not scroll it. Shortcuts and text being composed are not scrolling either;
    // anything that does scroll is caught by `scrolled`.
    const key = (event: KeyboardEvent) => {
      const target = event.target
      if (!(target instanceof Node) || (!root.contains(target) && target !== document.body && target !== document.documentElement)) return
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
      const up = UP_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)
      if (up && !isEditable(event.target) && movesPageUp(event.target, root)) leave()
    }
    // A scrollbar drag sends no wheel events; it is the only press whose target is the scroller itself.
    const press = (event: PointerEvent) => {
      if (event.target === root && root.scrollTop > 0) leave()
    }
    grew.observe(content)
    grew.observe(root)
    near.observe(end)
    root.addEventListener('scroll', scrolled, { passive: true })
    root.addEventListener('wheel', wheel, { passive: true })
    root.addEventListener('pointerdown', press, { passive: true })
    window.addEventListener('keydown', key)
    return () => {
      grew.disconnect()
      near.disconnect()
      root.removeEventListener('scroll', scrolled)
      root.removeEventListener('wheel', wheel)
      root.removeEventListener('pointerdown', press)
      window.removeEventListener('keydown', key)
    }
  }, [scrollRef, contentRef, endRef])

  // Engaged too, so the scroll this move causes is not taken as your first.
  const release = useCallback(() => {
    engaged.current = true
    follow.current = false
  }, [])
  return { release }
}
