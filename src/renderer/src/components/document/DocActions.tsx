import { useEffect, useState } from 'react'

import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { SparkIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'
import { Menu, MenuTrigger } from '../ui/menu'
import { MenuPanel } from '../ui/MenuPanel'
import { Tip } from '../ui/tooltip'
import { ShareDialog } from './ShareDialog'

/**
 * Right side of the document header, like Docs: version history (loads
 * earlier content), comments and Meet (costume), the Share split button
 * (Drive's share dialog, and a caret menu of its quick actions), and the spark.
 */
export function DocActions({ snap }: { snap: Snapshot }) {
  const [sharing, setSharing] = useState(false)
  const [copied, setCopied] = useState(false)
  const canLoadEarlier = Boolean(snap.olderTurnsCursor) && !snap.loadingOlder && !snap.streaming
  const threadId = snap.route.kind === 'doc' ? snap.route.threadId : null

  // Docs confirms a copied link with a snackbar that fades after a few seconds.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 4000)
    return () => clearTimeout(timer)
  }, [copied])
  const copyLink = () => {
    if (!threadId) return
    void navigator.clipboard?.writeText(threadId).then(() => setCopied(true))
  }

  return (
    <div className="doc-actions">
      <Tip label="Open version history">
        <button
          type="button"
          className="header-action"
          aria-label="Last edit was seconds ago"
          disabled={!canLoadEarlier}
          onClick={() => dispatch({ op: 'loadOlderTurns' })}
        >
          <MIcon name="history" size={24} />
        </button>
      </Tip>
      <Tip label="Open comment history">
        <span className="header-action" aria-hidden="true">
          <MIcon name="comment" size={24} />
        </span>
      </Tip>
      <Tip label="Join a call here or present this tab to the call">
        <span className="header-action meet" aria-hidden="true">
          <MIcon name="videocam" size={24} />
          <MIcon name="arrow_drop_down" />
        </span>
      </Tip>
      <div className="share">
        <Tip label="Private to only me">
          <button type="button" className="share-button" data-testid="share" onClick={() => setSharing(true)}>
            <MIcon name="lock" />
            <span>Share</span>
          </button>
        </Tip>
        <Menu>
          <Tip label="Quick sharing actions">
            <MenuTrigger className="share-caret" data-testid="share-menu" aria-label="Quick sharing actions">
              <MIcon name="arrow_drop_down" />
            </MenuTrigger>
          </Tip>
          <MenuPanel
            testId="panel-share"
            align="end"
            items={[
              { id: 'share-people', label: 'Share with others', icon: 'person_add', run: () => setSharing(true) },
              { id: 'copy', label: 'Copy link', icon: 'link', disabled: !threadId, run: copyLink },
            ]}
          />
        </Menu>
      </div>
      <span className="header-action spark" aria-hidden="true">
        <SparkIcon size={22} />
      </span>
      <ShareDialog snap={snap} open={sharing} onOpenChange={setSharing} onCopyLink={copyLink} />
      {copied ? (
        <div className="snackbar" role="status">
          Link copied
        </div>
      ) : null}
    </div>
  )
}
