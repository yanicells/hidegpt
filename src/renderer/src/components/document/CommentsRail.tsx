import { useLayoutEffect, useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'

import type { ApprovalBlock, Block, Snapshot } from '../../../../shared/model'
import { useSnapshotSelector } from '../../session-bridge'
import { SuggestionCard } from './Approval'

/** Docs' gap between stacked comment cards. */
const CARD_GAP = 12

/** What the comments margin needs right of the page: a 24px gap, the 256px card, 16px air (approvals.css). */
const RAIL_ROOM = 24 + 256 + 16

/** Left of the page with the panel open: the 16px ruler, a 5px gap and `--tabs-w` (workspace.css `--page-left`). */
const PANEL_ROOM = 21 + 280

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
 * because the rail lives inside the canvas. Folding the tabs panel is a React
 * update, so it is flushed inside the same callback, and only when it changes,
 * or the first frame after a resize would show the old layout. (Pattern from
 * T3 Code's `apps/web/src/lib/observeResize.ts` at 5c6f2f12, which flushes its
 * callbacks before paint for the same reason; no code is copied from it.)
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
  // What onCrowded last reported, so a resize that doesn't change it costs no render.
  const crowded = useRef<boolean | null>(null)
  // Re-subscribes when the set of cards changes, not when one card's answers do.
  const ids = cards.map((card) => card.id).join('\n')

  useLayoutEffect(() => {
    const rail = railRef.current
    const flow = flowRef.current
    const workspace = rail?.closest<HTMLElement>('.workspace')
    if (!rail || !flow || !workspace) return
    const place = (flush: (report: () => void) => void) => {
      placeCards(rail, flow)
      const next = isCrowded(workspace)
      if (next === crowded.current) return
      crowded.current = next
      flush(() => onCrowded(next))
    }
    // From the effect React commits the update itself; flushSync isn't allowed there.
    if (typeof ResizeObserver === 'undefined') {
      place((report) => report())
      return
    }
    const observer = new ResizeObserver(() => place(flushSync))
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
 * Whether the open tabs panel, the page and the rail overflow the canvas.
 * Mirrors the CSS: `PANEL_ROOM` (workspace.css), the 816px page (`--page-w`) times its zoom
 * plus the zoomed ruler's extra width (`--ruler-shift`, approvals.css), and
 * `RAIL_ROOM` (approvals.css); `clientWidth` already leaves out the scrollbar.
 * It depends only on the canvas width and the zoom, not on the panel, so
 * folding the panel can't flip it back.
 */
export function isCrowded(workspace: HTMLElement): boolean {
  const zoom = Number(getComputedStyle(workspace).getPropertyValue('--page-zoom')) || 1
  return workspace.clientWidth < PANEL_ROOM + 816 * zoom + 16 * (zoom - 1) + RAIL_ROOM
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
