import { useEffect, useLayoutEffect, useRef, type UIEvent } from 'react'

import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { BlockView } from './BlockView'
import { SparkIcon } from '../ui/Icons'
import { Composer } from './Composer'
import { Tabs } from './Tabs'

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
  const visibleBlocks = outputOnly
    ? snap.blocks.filter(
        (block) => block.kind !== 'callout' && !(block.kind === 'agent' && block.phase === 'commentary'),
      )
    : snap.blocks
  const lastBlock = visibleBlocks[visibleBlocks.length - 1]
  const streamingAgentId = snap.streaming && lastBlock?.kind === 'agent' ? lastBlock.id : null
  const waiting = snap.streaming && streamingAgentId === null
  const questions = snap.blocks.filter((block) => block.kind === 'user')

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(false)
  const seenBlocks = useRef<number | null>(null)
  const seenThread = useRef(threadId)
  const beforePrepend = useRef<{ height: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (snap.loadingOlder) beforePrepend.current = { height: el.scrollHeight, top: el.scrollTop }
    else if (beforePrepend.current) {
      el.scrollTop = beforePrepend.current.top + el.scrollHeight - beforePrepend.current.height
      beforePrepend.current = null
      seenBlocks.current = snap.blocks.length
      stickToBottom.current = false
    }
  }, [snap.loadingOlder, snap.blocks.length])
  useEffect(() => {
    const el = scrollRef.current
    if (!el || snap.blocks.length === 0) return
    if (seenThread.current !== threadId) {
      // A newly opened document starts at the top.
      seenThread.current = threadId
      seenBlocks.current = snap.blocks.length
      stickToBottom.current = false
      el.scrollTop = 0
      if (!snap.streaming) return
    }
    if (seenBlocks.current === null) {
      // First paint shows the top of an existing document; only a live turn pulls down.
      seenBlocks.current = snap.blocks.length
      if (!snap.streaming) return
    }
    const grew = snap.blocks.length !== seenBlocks.current
    seenBlocks.current = snap.blocks.length
    const last = snap.blocks[snap.blocks.length - 1]
    if (grew && last?.kind === 'user') {
      // Your own question always pulls the view down with it.
      stickToBottom.current = true
    }
    if ((grew || snap.streaming) && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [snap.blocks, snap.streaming, threadId])
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }
  const jumpTo = (id: string) => {
    const root = scrollRef.current
    const target = root?.querySelector(`[data-turn="${id}"]`)
    stickToBottom.current = false
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="workspace" data-testid="document" ref={scrollRef} onScroll={onScroll}>
      <div className="doc-layout">
        <VerticalRuler />
        <Tabs onNew={onNew} questions={questions} onJump={jumpTo} />
        <div className="paper-col">
          <Ruler />
          <article className="paper">
            {snap.olderTurnsCursor ? (
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
            {visibleBlocks.map((block) => (
              <div
                className="doc-block"
                data-turn={block.kind === 'user' ? block.id : undefined}
                key={block.id}
              >
                <BlockView block={block} streaming={block.id === streamingAgentId} />
              </div>
            ))}
            {waiting ? (
              <p className="doc-body pending" aria-live="polite" aria-label="Working">
                <span className="caret" />
              </p>
            ) : null}
            <Composer key={threadId} threadId={threadId} streaming={snap.streaming} skills={snap.skills} />
          </article>
        </div>
      </div>
      {/* Docs' floating spark pill; while an answer streams it pulses, and a click stops it. */}
      <div className="spark-wrap">
        {snap.streaming ? (
          <button
            type="button"
            className="spark-pill busy"
            data-testid="stop-turn"
            aria-label="Stop"
            title="Stop"
            onClick={() => dispatch({ op: 'interrupt' })}
          >
            <SparkIcon size={16} />
          </button>
        ) : (
          <span className="spark-pill" aria-hidden="true">
            <SparkIcon size={16} />
          </span>
        )}
      </div>
    </div>
  )
}

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
