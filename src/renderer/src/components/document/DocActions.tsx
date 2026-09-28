import { useRef, useState } from 'react'

import type { Block } from '../../../../codex/blocks'
import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { MIcon } from '../ui/MaterialIcon'
import { MenuPanel, useDismiss } from '../ui/MenuPanel'

/**
 * Right side of the document header, like Docs: history (loads earlier
 * content), comments (costume), and a Share split button whose menu copies
 * or prints the document.
 */
export function DocActions({ snap }: { snap: Snapshot }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  const canLoadEarlier = Boolean(snap.olderTurnsCursor) && !snap.loadingOlder && !snap.streaming

  return (
    <div className="doc-actions">
      <button
        type="button"
        className="header-action"
        aria-label="Load earlier"
        title="Load earlier"
        disabled={!canLoadEarlier}
        onClick={() => dispatch({ op: 'loadOlderTurns' })}
      >
        <MIcon name="history" size={24} />
      </button>
      <span className="header-action" aria-hidden="true">
        <MIcon name="comments" size={24} />
      </span>
      <div className="menu share" ref={ref}>
        <button
          type="button"
          className="share-button"
          data-testid="share"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <MIcon name="lock" size={18} />
          <span>Share</span>
        </button>
        <button
          type="button"
          className="share-caret"
          aria-label="Share options"
          aria-haspopup="menu"
          onClick={() => setOpen(!open)}
        >
          <MIcon name="dropDown" size={20} />
        </button>
        {open ? (
          <MenuPanel
            testId="panel-share"
            align="end"
            onClose={() => setOpen(false)}
            items={[
              {
                id: 'copy',
                label: 'Copy document',
                run: () => void navigator.clipboard?.writeText(documentText(snap.blocks)),
              },
              { id: 'print', label: 'Print', run: () => window.print() },
            ]}
          />
        ) : null}
      </div>
    </div>
  )
}

/** The page as plain Markdown: questions in bold, answers as written. */
export function documentText(blocks: Block[]): string {
  return blocks
    .flatMap((block) => {
      if (block.kind === 'user' && block.text) return [`**${block.text}**`]
      if (block.kind === 'agent' && block.text) return [block.text]
      return []
    })
    .join('\n\n')
}
