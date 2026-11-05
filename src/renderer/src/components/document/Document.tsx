import { memo, useCallback, useLayoutEffect, useRef } from 'react'

import type { Block, Snapshot } from '../../../../shared/model'
import { dispatch, useBlocks } from '../../session-bridge'
import { BlockView } from './BlockView'
import { Composer } from './Composer'
import { Tabs } from './Tabs'
import { useFollowBottom } from './useFollowBottom'
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

  const scrollRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<HTMLElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const { release } = useFollowBottom({
    scrollRef,
    contentRef: paperRef,
    endRef,
    askedId: newest?.kind === 'user' ? newest.id : null,
  })

  // "Load earlier" adds turns above you; keep what you were reading in place.
  const beforePrepend = useRef<{ height: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (snap.loadingOlder) beforePrepend.current = { height: el.scrollHeight, top: el.scrollTop }
    else if (beforePrepend.current) {
      el.scrollTop = beforePrepend.current.top + el.scrollHeight - beforePrepend.current.height
      beforePrepend.current = null
      release()
    }
  }, [snap.loadingOlder, blocks.length, release])

  const jumpTo = useCallback(
    (id: string) => {
      const root = scrollRef.current
      const target = root?.querySelector(`[data-turn="${id}"]`)
      if (!root || !target) return
      release()
      target.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      // Blocks scrolled past may only now take their real height; settle on the target.
      root.addEventListener('scrollend', () => target.scrollIntoView?.({ block: 'start' }), { once: true })
    },
    [release],
  )

  return (
    <div className="workspace" data-testid="document" ref={scrollRef}>
      <div className="doc-layout">
        <Tabs onNew={onNew} questions={questions} onJump={jumpTo} />
        <div className="paper-col">
          <Ruler />
          <article className="paper" ref={paperRef}>
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
            {visibleBlocks.slice(0, rows).map((block, index) => (
              <BlockRow
                key={block.id}
                block={block}
                turnStart={block.kind === 'user' && index > 0}
                streaming={block.id === streamingAgentId}
              />
            ))}
            {waiting ? (
              <p className="doc-body pending" aria-live="polite" aria-label="Working">
                <span className="caret" />
              </p>
            ) : null}
            <Composer key={threadId} threadId={threadId} streaming={snap.streaming} skills={snap.skills} />
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

/** One block on the page. Unchanged blocks keep their identity, so a delta skips every other row. */
const BlockRow = memo(function BlockRow({ block, turnStart, streaming }: { block: Block; turnStart: boolean; streaming: boolean }) {
  return (
    <div className={`doc-block${turnStart ? ' turn-start' : ''}`} data-turn={block.kind === 'user' ? block.id : undefined}>
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
