import { useLayoutEffect, useRef, type RefObject } from 'react'

import type { ApprovalBlock } from '../../../../shared/model'
import { SuggestionCard } from './Approval'

/** Docs' gap between stacked comment cards. */
const CARD_GAP = 12

/**
 * Docs' comments margin: the pending suggestion cards, 24px right of the page
 * and outside its zoom, so a card stays 256px at any page zoom (approvals.css).
 * Each card sits level with its suggestion's line in the page (`Approval`) and
 * stacks 12px under the card above, so cards never overlap.
 *
 * Positions are written straight to the cards from one ResizeObserver: it
 * fires after layout and before paint, when the page text re-flows, the page
 * zooms or a card grows, so a card never shows a frame out of place and no
 * scroll handler runs. The cards scroll with the page because the rail lives
 * inside the canvas. (T3 Code's `apps/web/src/lib/observeResize.ts` makes the
 * same before-paint point; nothing is copied from it.)
 */
export function CommentsRail({
  cards,
  flowRef,
}: {
  cards: ReadonlyArray<ApprovalBlock>
  /** The page's text flow, where each card's anchor row is. */
  flowRef: RefObject<HTMLElement | null>
}) {
  const railRef = useRef<HTMLDivElement>(null)
  // Re-subscribes when the set of cards changes, not on every delta.
  const ids = cards.map((card) => card.id).join('\n')

  useLayoutEffect(() => {
    const rail = railRef.current
    const flow = flowRef.current
    if (!rail || !flow) return
    const place = () => placeCards(rail, flow)
    if (typeof ResizeObserver === 'undefined') {
      place()
      return
    }
    const observer = new ResizeObserver(place)
    // The flow re-flows with text and zoom; the rail's parent with the window; each card with its fields.
    observer.observe(flow)
    if (rail.parentElement) observer.observe(rail.parentElement)
    for (const card of rail.children) observer.observe(card)
    return () => observer.disconnect()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new set of cards needs placing and observing
  }, [ids, flowRef])

  if (cards.length === 0) return null
  return (
    <div className="comments-rail" ref={railRef}>
      {cards.map((block) => (
        <SuggestionCard key={block.id} block={block} />
      ))}
    </div>
  )
}

/**
 * Moves each card level with its anchor, below the card before it. All reads
 * come first and all writes after, so one pass costs one layout.
 */
export function placeCards(rail: HTMLElement, flow: HTMLElement): void {
  const cards = Array.from(rail.children as HTMLCollectionOf<HTMLElement>)
  const anchors = new Map<string, Element>()
  for (const row of flow.querySelectorAll<HTMLElement>('.doc-block > .suggestion-row')) {
    const id = row.parentElement?.dataset.block
    if (id) anchors.set(id, row)
  }
  const railTop = rail.getBoundingClientRect().top
  const wanted = cards.map((card) => {
    const anchor = anchors.get(card.dataset.anchor ?? '')
    return {
      y: anchor ? anchor.getBoundingClientRect().top - railTop : 0,
      height: card.offsetHeight,
    }
  })
  let floor = -Infinity
  const tops = wanted.map(({ y, height }) => {
    const top = Math.max(y, floor)
    floor = top + height + CARD_GAP
    return top
  })
  cards.forEach((card, index) => {
    card.style.top = `${tops[index]}px`
  })
}
