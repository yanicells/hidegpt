import { useEffect, useLayoutEffect, useRef, type UIEvent } from 'react'

import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { BlockView } from './BlockView'
import { Composer } from './Composer'
import { Tabs } from './Tabs'

export function Document({ snap, onNew }: { snap: Snapshot; onNew: () => void }) {
  const threadId = snap.route.kind === 'doc' ? snap.route.threadId : ''
  const lastBlock = snap.blocks[snap.blocks.length - 1]
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
            {snap.blocks.map((block, index) => (
              <div
                className={`doc-block${block.kind === 'user' && index > 0 ? ' turn-start' : ''}`}
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
            <Composer key={threadId} threadId={threadId} streaming={snap.streaming} />
          </article>
        </div>
      </div>
      {snap.streaming ? (
        <div className="stop-wrap">
          <button type="button" className="stop" data-testid="stop-turn" onClick={() => dispatch({ op: 'interrupt' })}>
            <span className="stop-square" aria-hidden="true" />
            Stop
          </button>
        </div>
      ) : null}
    </div>
  )
}

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
