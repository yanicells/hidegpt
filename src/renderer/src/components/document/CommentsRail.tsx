import { useLayoutEffect, useRef, type RefObject } from 'react'

import type { ApprovalBlock, Block, Snapshot } from '../../../../shared/model'
import { useSnapshotSelector } from '../../session-bridge'
import { SuggestionCard } from './Approval'

/** Docs' gap between stacked comment cards. */
const CARD_GAP = 12

/** What the comments margin needs right of the page: a 24px gap, the 256px card, 16px air. */
const RAIL_ROOM = 24 + 256 + 16

const isPendingSuggestion = (block: Block): block is ApprovalBlock => block.kind === 'approval' && !block.resolved
const pendingSuggestions = (snap: Snapshot) => snap.blocks.filter(isPendingSuggestion)
const sameCards = (a: ReadonlyArray<ApprovalBlock>, b: ReadonlyArray<ApprovalBlock>) =>
  a.length === b.length && a.every((card, index) => card === b[index])

/** Whether a suggestion card is pending, for the page to make room for the rail. */
export const hasPendingSuggestion = (snap: Snapshot): boolean => snap.blocks.some(isPendingSuggestion)

/**
 * Docs' comments margin: the pending suggestion cards, 24px right of the page
 * and outside its zoom, so a card stays 256px at any page zoom (approvals.css).
 * Each card sits level with its suggestion's line in the page (`Approval`) and
 * stacks 12px under the card above, so cards never overlap. The rail reads the
 * pending cards itself, so a streamed delta elsewhere doesn't re-render it.
 *
 * Positions are written straight to the cards from one ResizeObserver: it
 * fires after layout and before paint, when the page text re-flows, the page
 * zooms, the window resizes or a card grows, so a card never shows a frame
 * out of place and no scroll handler runs. The cards scroll with the page
 * because the rail lives inside the canvas. (T3 Code's
 * `apps/web/src/lib/observeResize.ts` makes the same before-paint point;
 * nothing is copied from it.)
 */
export function CommentsRail({
  flowRef,
  onCrowded,
}: {
  /** The page's text flow, where each card's anchor row is. */
  flowRef: RefObject<HTMLElement | null>
  /** Whether the canvas is too narrow for the rail with the tabs panel open; Document folds the panel. */
  onCrowded: (crowded: boolean) => void
}) {
  const cards = useSnapshotSelector(pendingSuggestions, sameCards)
  const railRef = useRef<HTMLDivElement>(null)
  // Re-subscribes when the set of cards changes, not when one card's answers do.
  const ids = cards.map((card) => card.id).join('\n')

  useLayoutEffect(() => {
    const rail = railRef.current
    const flow = flowRef.current
    const workspace = rail?.closest<HTMLElement>('.workspace')
    if (!rail || !flow || !workspace) return
    const place = () => {
      placeCards(rail, flow)
      onCrowded(isCrowded(workspace))
    }
    if (typeof ResizeObserver === 'undefined') {
      place()
      return
    }
    const observer = new ResizeObserver(place)
    // The flow re-flows with text and zoom; the canvas with the window; each card with its fields.
    observer.observe(flow)
    observer.observe(workspace)
    if (rail.parentElement) observer.observe(rail.parentElement)
    for (const card of rail.children) observer.observe(card)
    return () => observer.disconnect()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new set of cards needs placing and observing
  }, [ids, flowRef, onCrowded])

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
 * Whether the page, the open tabs panel and the rail overflow the canvas
 * (workspace.css' layout: 16px ruler + 5px gap + 280px panel, the page, and
 * the zoomed ruler's extra width). It depends only on the canvas width and
 * the zoom, not on the panel, so folding the panel can't flip it back.
 */
function isCrowded(workspace: HTMLElement): boolean {
  const zoom = Number(getComputedStyle(workspace).getPropertyValue('--page-zoom')) || 1
  return workspace.clientWidth < 21 + 280 + 816 * zoom + 16 * (zoom - 1) + RAIL_ROOM
}

/**
 * Moves each card level with its anchor, below the card before it. All reads
 * come first and all writes after, so one pass costs one layout. A card whose
 * row isn't on the page yet (a long document still opening) stays hidden and
 * takes no room.
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
      y: anchor ? anchor.getBoundingClientRect().top - railTop : null,
      height: card.offsetHeight,
    }
  })
  let floor = -Infinity
  const tops = wanted.map(({ y, height }) => {
    if (y === null) return null
    const top = Math.max(y, floor)
    floor = top + height + CARD_GAP
    return top
  })
  cards.forEach((card, index) => {
    const top = tops[index]
    card.style.visibility = top === null ? 'hidden' : ''
    if (top !== null) card.style.top = `${top}px`
  })
}
