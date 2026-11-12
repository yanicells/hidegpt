import { memo, useCallback, useEffect, useRef } from 'react'

import type { Block, Snapshot } from '../../../../shared/model'
import { dispatch, useBlocks } from '../../session-bridge'
import { SparkIcon } from '../ui/Icons'
import { BlockView } from './BlockView'
import { Composer } from './Composer'
import { outlineEntries, type OutlineEntry } from './outline'
import { PAGE_HEIGHT, PAGE_PITCH, usePages } from './pages'
import { Tabs } from './Tabs'
import { useFollowBottom } from './useFollowBottom'
import { useKeepPlace } from './useKeepPlace'
import { useProgressiveRows } from './useProgressiveRows'

/**
 * The open document. `snap` is the shell's copy, which skips streamed text;
 * the blocks come from their own subscription, so a delta re-renders only the
 * block that changed.
 */
export function Document({
  snap,
  onNew,
  outputOnly = false,
}: {
  snap: Snapshot
  onNew: () => void
  outputOnly?: boolean
}) {
  const threadId = snap.route.kind === 'doc' ? snap.route.threadId : ''
  const blocks = useBlocks()
  const visibleBlocks = outputOnly
    ? blocks.filter((block) => block.kind !== 'callout' && !(block.kind === 'agent' && block.commentary))
    : blocks
  const lastBlock = visibleBlocks[visibleBlocks.length - 1]
  const streamingAgentId = snap.streaming && lastBlock?.kind === 'agent' ? lastBlock.id : null
  const waiting = snap.streaming && streamingAgentId === null
  const outline = outlineEntries(visibleBlocks)
  const newest = blocks[blocks.length - 1]
  const rows = useProgressiveRows(visibleBlocks.length)
  // The composer waits for the last rows, so it never shows mid-document while a long one opens.
  const allRows = rows >= visibleBlocks.length

  const scrollRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const pages = usePages(paperRef)
  const { release } = useFollowBottom({
    scrollRef,
    contentRef,
    endRef,
    askedId: newest?.kind === 'user' ? newest.id : null,
  })

  useKeepPlace(scrollRef, snap.loadingOlder, release)

  // Blocks scrolled past may only take their real height mid-jump, so a jump settles on its
  // target when the smooth scroll ends, unless you take over first or it never moved.
  const settling = useRef<AbortController | null>(null)
  useEffect(() => () => settling.current?.abort(), [])
  const jumpTo = useCallback(
    (entry: OutlineEntry) => {
      const root = scrollRef.current
      const block = root?.querySelector(`[data-block="${entry.blockId}"]`)
      const target = entry.heading === undefined ? block : (block?.querySelectorAll('h1, h2, h3')[entry.heading] ?? block)
      if (!root || !target) return
      release()
      settling.current?.abort()
      const settle = new AbortController()
      settling.current = settle
      const { signal } = settle
      target.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      root.addEventListener(
        'scrollend',
        () => {
          settle.abort()
          target.scrollIntoView?.({ block: 'start' })
        },
        { signal },
      )
      for (const type of ['wheel', 'pointerdown', 'keydown'] as const) {
        window.addEventListener(type, () => settle.abort(), { signal, passive: true })
      }
      window.setTimeout(() => settle.abort(), JUMP_SETTLE_MS)
    },
    [release],
  )

  return (
    <div className="workspace" data-testid="document" ref={scrollRef}>
      <div className="doc-layout">
        <VerticalRuler />
        <Tabs onNew={onNew} entries={outline} onJump={jumpTo} />
        <div className="paper-col">
          <Ruler />
          <article className="paper" ref={paperRef} style={{ minHeight: (pages - 1) * PAGE_PITCH + PAGE_HEIGHT }}>
            {/* Print layout: the sheets are drawn behind one flow of text that usePages breaks between them. */}
            <div className="page-sheets" aria-hidden="true">
              {Array.from({ length: pages }, (_, index) => (
                <div key={index} className="page-sheet" style={{ top: index * PAGE_PITCH }} />
              ))}
            </div>
            {snap.hasOlder ? (
              <button
                type="button"
                className="load-older"
                data-testid="load-older"
                disabled={snap.loadingOlder || snap.streaming || !allRows}
                onClick={() => dispatch({ op: 'loadOlderTurns' })}
              >
                {snap.loadingOlder ? 'Loading earlier text…' : 'Show earlier text'}
              </button>
            ) : null}
            {/* What follow-bottom watches grow: unlike the paper, it has no minimum height. */}
            <div className="paper-flow" ref={contentRef}>
              {visibleBlocks.slice(0, rows).map((block) => (
                <BlockRow key={block.id} block={block} streaming={block.id === streamingAgentId} />
              ))}
              {allRows && waiting ? (
                <p className="doc-body pending" aria-live="polite" aria-label="Working">
                  <span className="caret" />
                </p>
              ) : null}
              {allRows ? <Composer threadId={threadId} streaming={snap.streaming} skills={snap.skills} /> : null}
            </div>
            <div className="paper-end" ref={endRef} aria-hidden="true" />
          </article>
        </div>
      </div>
      {/* Docs' floating spark pill; while an answer streams, a click stops it. */}
      <div className="spark-wrap">
        {snap.streaming ? (
          // Stays disabled from the click until the turn really ends.
          <button
            type="button"
            className="spark-pill busy"
            data-testid="stop-turn"
            aria-label="Stop"
            disabled={snap.stopping}
            onClick={() => dispatch({ op: 'interrupt' })}
          >
            <SparkIcon size={16} mono />
          </button>
        ) : (
          <span className="spark-pill" aria-hidden="true">
            <SparkIcon size={16} mono />
          </span>
        )}
      </div>
    </div>
  )
}

/** How long a jump waits for its smooth scroll to end before giving up on settling. */
const JUMP_SETTLE_MS = 3000

/** One block on the page. Unchanged blocks keep their identity, so a delta skips every other row. */
const BlockRow = memo(function BlockRow({ block, streaming }: { block: Block; streaming: boolean }) {
  return (
    <div
      className="doc-block"
      data-block={block.id}
      data-turn={block.kind === 'user' ? block.id : undefined}
      data-streaming={streaming || undefined}
    >
      <BlockView block={block} streaming={streaming} />
    </div>
  )
})

const INCHES = [-1, 1, 2, 3, 4, 5, 6, 7]

/**
 * Docs' horizontal ruler over the page: inches count from the left margin,
 * the margins are shaded, and blue markers sit at both indents. Decorative.
 */
function Ruler() {
  return (
    <div className="ruler" aria-hidden="true">
      <div className="ruler-track">
        {INCHES.map((inch) => (
          <span key={inch} className="ruler-num" style={{ left: 96 + inch * 96 }}>
            {Math.abs(inch)}
          </span>
        ))}
        <i className="ruler-indent ruler-indent-left" />
        <i className="ruler-indent ruler-indent-right" />
      </div>
    </div>
  )
}

/** The vertical ruler along the left edge of the editor. Decorative. */
function VerticalRuler() {
  return (
    <div className="vruler" aria-hidden="true">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((inch) => (
        <span key={inch} className="vruler-num" style={{ top: 96 + inch * 96 }}>
          {inch}
        </span>
      ))}
    </div>
  )
}
