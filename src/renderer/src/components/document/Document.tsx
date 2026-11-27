import { memo, useCallback, useEffect, useRef } from 'react'

import type { Snapshot } from '../../../../shared/model'
import { dispatch, useBlock, useBlockRows } from '../../session-bridge'
import { BlockFallback, RenderErrorBoundary } from '../layout/RenderErrorBoundary'
import { SparkIcon } from '../ui/Icons'
import { BlockView } from './BlockView'
import { Composer } from './Composer'
import { inOutputView, useOutline, type OutlineEntry } from './outline'
import { Paper } from './Paper'
import { Tabs } from './Tabs'
import { useFollowBottom } from './useFollowBottom'
import { useKeepPlace } from './useKeepPlace'
import { useProgressiveRows } from './useProgressiveRows'

/**
 * The open document. `snap` is the shell's copy, which skips streamed text.
 * The document reads only which rows there are; each row, the outline and the
 * page count have their own subscriptions, so a streamed delta re-renders the
 * row being written and nothing else.
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
  const blockRows = useBlockRows()
  const visibleRows = outputOnly ? blockRows.filter(inOutputView) : blockRows
  const lastRow = visibleRows[visibleRows.length - 1]
  const streamingAgentId = snap.streaming && lastRow?.kind === 'agent' ? lastRow.id : null
  const waiting = snap.streaming && streamingAgentId === null
  const newest = blockRows[blockRows.length - 1]
  const rows = useProgressiveRows(visibleRows.length)
  // The composer waits for the last rows, so it never shows mid-document while a long one opens.
  const allRows = rows >= visibleRows.length

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
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
      const target =
        entry.heading === undefined ? block : (block?.querySelectorAll('h1, h2, h3')[entry.heading] ?? block)
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
        <Outline outputOnly={outputOnly} onNew={onNew} onJump={jumpTo} />
        <div className="paper-col">
          <Ruler />
          <Paper>
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
              {visibleRows.slice(0, rows).map((row) => (
                <BlockRow key={row.id} id={row.id} streaming={row.id === streamingAgentId} />
              ))}
              {allRows && waiting ? (
                <p className="doc-body pending" aria-live="polite" aria-label="Working">
                  <span className="caret" />
                </p>
              ) : null}
              {allRows ? <Composer threadId={threadId} streaming={snap.streaming} skills={snap.skills} /> : null}
            </div>
            <div className="paper-end" ref={endRef} aria-hidden="true" />
          </Paper>
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

/** The "Document tabs" panel, subscribed to the outline so a heading re-renders only the panel. */
function Outline({
  outputOnly,
  onNew,
  onJump,
}: {
  outputOnly: boolean
  onNew: () => void
  onJump: (entry: OutlineEntry) => void
}) {
  return <Tabs onNew={onNew} entries={useOutline(outputOnly)} onJump={onJump} />
}

/** One block on the page. It reads its own block, so a delta to another block never renders it. */
const BlockRow = memo(function BlockRow({ id, streaming }: { id: string; streaming: boolean }) {
  const block = useBlock(id)
  // Only between a patch removing the block and the document dropping its row.
  if (!block) return null
  return (
    <div
      className="doc-block"
      data-block={block.id}
      data-turn={block.kind === 'user' ? block.id : undefined}
      data-streaming={streaming || undefined}
    >
      {/* A block that can't render (bad Markdown, say) stands alone; a new version of it tries again. */}
      <RenderErrorBoundary fallback={<BlockFallback />} resetKeys={[block]}>
        <BlockView block={block} streaming={streaming} />
      </RenderErrorBoundary>
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
