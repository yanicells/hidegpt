import { useState } from 'react'

import type { Block } from '../../../../codex/blocks'
import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { SparkIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'
import { Menu, MenuTrigger } from '../ui/menu'
import { MenuPanel } from '../ui/MenuPanel'

/**
 * Right side of the document header, like Docs: version history (loads
 * earlier content), comments and Meet (costume), a Share split button whose
 * menu copies or prints the document, and the spark.
 */
export function DocActions({ snap }: { snap: Snapshot }) {
  const [open, setOpen] = useState(false)
  const canLoadEarlier = Boolean(snap.olderTurnsCursor) && !snap.loadingOlder && !snap.streaming

  return (
    <div className="doc-actions">
      <button
        type="button"
        className="header-action"
        aria-label="Last edit was seconds ago"
        title="Open version history"
        disabled={!canLoadEarlier}
        onClick={() => dispatch({ op: 'loadOlderTurns' })}
      >
        <MIcon name="history" size={24} />
      </button>
      <span className="header-action" aria-hidden="true" title="Open comment history">
        <MIcon name="comment" size={24} />
      </span>
      <span className="header-action meet" aria-hidden="true" title="Join a call here or present this tab to the call">
        <MIcon name="videocam" size={24} />
        <MIcon name="arrow_drop_down" />
      </span>
      <Menu open={open} onOpenChange={setOpen}>
        <div className="share">
          {/* Docs' Share opens its sharing dialog; here both halves open quick actions. */}
          <button
            type="button"
            className="share-button"
            data-testid="share"
            aria-haspopup="menu"
            aria-expanded={open}
            title="Private to only me"
            onClick={() => setOpen(true)}
          >
            <MIcon name="lock" />
            <span>Share</span>
          </button>
          <MenuTrigger className="share-caret" aria-label="Quick sharing actions">
            <MIcon name="arrow_drop_down" />
          </MenuTrigger>
        </div>
          <MenuPanel
            testId="panel-share"
            align="end"
            items={[
              {
                id: 'copy',
                label: 'Copy link',
                icon: 'link',
                title: 'Copies the document text',
                run: () => void navigator.clipboard?.writeText(documentText(snap.blocks)),
              },
              { id: 'print', label: 'Print', icon: 'print', shortcut: '⌘P', run: () => window.print() },
            ]}
          />
      </Menu>
      <span className="header-action spark" aria-hidden="true">
        <SparkIcon size={22} />
      </span>
    </div>
  )
}

/** The page as plain Markdown: questions as headings, answers as written. */
export function documentText(blocks: Block[]): string {
  return blocks
    .flatMap((block) => {
      if (block.kind === 'user' && block.text) return [`# ${block.text}`]
      if (block.kind === 'agent' && block.text) return [block.text]
      return []
    })
    .join('\n\n')
}
