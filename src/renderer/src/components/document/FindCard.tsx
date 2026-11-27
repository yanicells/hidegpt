import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import { MIcon } from '../ui/MaterialIcon'
import { Menu, MenuTrigger } from '../ui/menu'
import { MenuPanel } from '../ui/MenuPanel'
import { Tip } from '../ui/tooltip'
import { findRanges, paintMatches } from './find'

/** How long the count waits after the page changes (a streaming answer) before it searches again. */
const RECOUNT_MS = 200

/** A match this close under the canvas top sits behind the ruler or this card, so it counts as off screen. */
const COVERED_TOP = 96

type Found = { ranges: Range[]; current: number }

export type FindTargets = {
  /** The page's text, searched. */
  flowRef: RefObject<HTMLElement | null>
  /** The canvas that scrolls a match into view. */
  scrollRef: RefObject<HTMLElement | null>
  /** Stops following the bottom of a streaming answer before a jump. */
  release: () => void
}

/**
 * Docs' "Find in document" card at the top right of the canvas, loaded on the
 * first Cmd+F by FindBar and kept mounted after, so a second Cmd+F shows the
 * last query. Matches are painted with the CSS Custom Highlight API (find.ts),
 * so the page's DOM and its memoised rows are untouched. Enter and Shift+Enter
 * step through the matches, Escape closes.
 */
export function FindCard({
  flowRef,
  scrollRef,
  release,
  open,
  summons,
  onClose,
}: FindTargets & {
  open: boolean
  /** Bumped by each Cmd+F, so a second one re-selects the field like the first. */
  summons: number
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [found, setFound] = useState<Found>({ ranges: [], current: 0 })
  const inputRef = useRef<HTMLInputElement>(null)

  // Each Cmd+F (a new `summons`) selects the field again, even while the card is open.
  useEffect(() => {
    if (!open || summons === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, summons])

  /** Scrolls `range` into the middle of the canvas unless it is already in view. */
  const reveal = useCallback(
    (range: Range | undefined) => {
      const view = scrollRef.current?.getBoundingClientRect()
      if (!range || !view) return
      const box = range.getBoundingClientRect?.()
      if (box && box.top >= view.top + COVERED_TOP && box.bottom <= view.bottom) return
      release()
      range.startContainer.parentElement?.scrollIntoView?.({ block: 'center' })
    },
    [scrollRef, release],
  )

  // A new query (or match case) searches from the top and shows the first match.
  useEffect(() => {
    const root = flowRef.current
    if (!open || !root) return
    const ranges = findRanges(root, query, matchCase)
    setFound({ ranges, current: 0 })
    reveal(ranges[0])
  }, [open, query, matchCase, flowRef, reveal])

  // While it is open, a page that changes is counted again, keeping the current match but not scrolling to it.
  useEffect(() => {
    const root = flowRef.current
    if (!open || !query || !root) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const ranges = findRanges(root, query, matchCase)
        setFound((last) => ({ ranges, current: Math.min(last.current, Math.max(ranges.length - 1, 0)) }))
      }, RECOUNT_MS)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [open, query, matchCase, flowRef])

  useEffect(() => {
    paintMatches(open ? found.ranges : [], found.current)
  }, [open, found])
  useEffect(() => () => paintMatches([], 0), [])

  const step = (by: 1 | -1) => {
    const count = found.ranges.length
    if (count === 0) return
    const current = (found.current + by + count) % count
    setFound({ ranges: found.ranges, current })
    reveal(found.ranges[current])
  }

  if (!open) return null
  const count = found.ranges.length
  return (
    <div className="find-anchor">
      <div className="find-bar" role="search" aria-label="Find in document" data-testid="find-bar">
        <label className="find-field">
          <span className="find-label">Find in document</span>
          <input
            ref={inputRef}
            className="find-input"
            data-testid="find-input"
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                step(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
            }}
          />
          {query ? (
            <span className="find-count" data-testid="find-count" aria-live="polite">
              {count === 0 ? '0 of 0' : `${found.current + 1} of ${count}`}
            </span>
          ) : null}
        </label>
        <Tip label="Previous">
          <button
            type="button"
            className="find-button"
            aria-label="Previous"
            disabled={count === 0}
            onClick={() => step(-1)}
          >
            <MIcon name="keyboard_arrow_up" />
          </button>
        </Tip>
        <Tip label="Next">
          <button
            type="button"
            className="find-button"
            aria-label="Next"
            disabled={count === 0}
            onClick={() => step(1)}
          >
            <MIcon name="keyboard_arrow_down" />
          </button>
        </Tip>
        <Menu>
          <Tip label="More options">
            <MenuTrigger className="find-button" aria-label="More options">
              <MIcon name="more_vert" />
            </MenuTrigger>
          </Tip>
          <MenuPanel
            align="end"
            items={[{ id: 'match-case', label: 'Match case', checked: matchCase, run: () => setMatchCase(!matchCase) }]}
            itemPrefix="find"
          />
        </Menu>
        <Tip label="Close">
          <button type="button" className="find-button" aria-label="Close" data-testid="find-close" onClick={onClose}>
            <MIcon name="close" />
          </button>
        </Tip>
      </div>
    </div>
  )
}
