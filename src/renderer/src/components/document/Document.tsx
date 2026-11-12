import { memo, useCallback, useEffect, useRef } from 'react'

import type { Block, Snapshot } from '../../../../shared/model'
import { dispatch, useBlocks } from '../../session-bridge'
import { BlockView } from './BlockView'
import { Composer } from './Composer'
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
  const questions = blocks.filter((block) => block.kind === 'user')
  const newest = blocks[blocks.length - 1]
  const rows = useProgressiveRows(visibleBlocks.length)
  // The composer waits for the last rows, so it never shows mid-document while a long one opens.
  const allRows = rows >= visibleBlocks.length

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
    (id: string) => {
      const root = scrollRef.current
      const target = root?.querySelector(`[data-turn="${id}"]`)
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
        <Tabs onNew={onNew} questions={questions} onJump={jumpTo} />
        <div className="paper-col">
          <Ruler />
          <article className="paper">
            {snap.hasOlder ? (
              <button
                type="button"
                className="load-older"
                data-testid="load-older"
                disabled={snap.loadingOlder || snap.streaming}
                onClick={() => dispatch({ op: 'loadOlderTurns' })}
              >
                {snap.loadingOlder ? 'Loading…' : 'Load earlier'}
              </button>
            ) : null}
            {/* What follow-bottom watches grow: unlike the paper, it has no minimum height. */}
            <div ref={contentRef}>
              {visibleBlocks.slice(0, rows).map((block, index) => (
                <BlockRow
                  key={block.id}
                  block={block}
                  turnStart={block.kind === 'user' && index > 0}
                  streaming={block.id === streamingAgentId}
                />
              ))}
              {allRows && waiting ? (
                <p className="doc-body pending" aria-live="polite" aria-label="Working">
                  <span className="caret" />
                </p>
              ) : null}
              {allRows ? <Composer threadId={threadId} streaming={snap.streaming} skills={snap.skills} /> : null}
            </div>
            <div ref={endRef} aria-hidden="true" />
          </article>
        </div>
      </div>
      {snap.streaming ? (
        <div className="stop-wrap">
          {/* Stays "Stopping…" from the click until the turn really ends. */}
          <button
            type="button"
            className="stop"
            data-testid="stop-turn"
            disabled={snap.stopping}
            onClick={() => dispatch({ op: 'interrupt' })}
          >
            <span className="stop-square" aria-hidden="true" />
            {snap.stopping ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** How long a jump waits for its smooth scroll to end before giving up on settling. */
const JUMP_SETTLE_MS = 3000

/** One block on the page. Unchanged blocks keep their identity, so a delta skips every other row. */
const BlockRow = memo(function BlockRow({ block, turnStart, streaming }: { block: Block; turnStart: boolean; streaming: boolean }) {
  return (
    <div
      className={`doc-block${turnStart ? ' turn-start' : ''}`}
      data-turn={block.kind === 'user' ? block.id : undefined}
      data-streaming={streaming || undefined}
    >
      <BlockView block={block} streaming={streaming} />
    </div>
  )
})

/** Decorative inch ruler above the paper, like Docs. */
function Ruler() {
  return (
    <div className="ruler" aria-hidden="true">
      {[1, 2, 3, 4, 5, 6, 7].map((inch) => (
        <span key={inch} className="ruler-num" style={{ left: `${(inch / 8) * 100}%` }}>
          {inch}
        </span>
      ))}
      <i className="ruler-tab ruler-tab-left" />
      <i className="ruler-tab ruler-tab-right" />
    </div>
  )
}
