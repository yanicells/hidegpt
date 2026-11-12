import { useEffect, useRef, useState, type RefObject } from 'react'

import type { Snapshot } from '../../../../shared/model'
import { dispatch } from '../../session-bridge'
import { threadProjectId } from '../home/projects'
import { AccountMenu } from '../layout/AccountMenu'
import { SideRail } from '../layout/SideRail'
import { DocsIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'
import { Tip } from '../ui/tooltip'
import { DocActions } from './DocActions'
import { DocMenus } from './DocMenus'
import { Toolbar } from './Toolbar'

export function DocumentChrome({
  snap,
  outputOnly,
  onToggleOutputOnly,
  onNew,
  titleRef,
  onGrid,
  onList,
}: {
  snap: Snapshot
  outputOnly: boolean
  onToggleOutputOnly: () => void
  onNew: () => void
  titleRef: RefObject<HTMLInputElement | null>
  onGrid: () => void
  onList: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelRef = useRef(false)
  const thread = snap.threads.find((item) => snap.route.kind === 'doc' && item.id === snap.route.threadId)
  const project = snap.projects.find((item) => thread && item.id === threadProjectId(snap, thread))
  const saved = useSavedFlash(snap.streaming)

  const commit = () => {
    if (cancelRef.current) {
      cancelRef.current = false
      setDraft(null)
      return
    }
    const next = (draft ?? snap.title).trim() || 'Untitled document'
    if (next !== snap.title) dispatch({ op: 'setDocumentName', name: next })
    setDraft(null)
  }

  return (
    <header className="doc-chrome">
      <div className="doc-top">
        <Tip label="Docs home">
          <button type="button" className="doc-home" aria-label="Docs home" onClick={() => dispatch({ op: 'goHome' })}>
            <DocsIcon size={40} />
          </button>
        </Tip>
        <div className="doc-head">
          <div className="doc-title-row">
            <Tip label="Rename">
              <input
                ref={titleRef}
                className="doc-title"
                value={draft ?? snap.title}
                aria-label="Document title"
                spellCheck={false}
                onFocus={() => {
                  cancelRef.current = false
                  setDraft(snap.title)
                }}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.currentTarget.blur()
                  }
                  if (event.key === 'Escape') {
                    cancelRef.current = true
                    setDraft(null)
                    event.currentTarget.blur()
                  }
                }}
              />
            </Tip>
            <Tip label="Star">
              <span className="title-icon" aria-hidden="true">
                <MIcon name="star" />
              </span>
            </Tip>
            <Tip label={`Move · ${project?.name ?? 'My Drive'}`}>
              <span className="title-icon document-location" aria-hidden="true">
                <MIcon name="drive_file_move" />
              </span>
            </Tip>
            <Tip label={snap.streaming ? 'Saving…' : 'All changes saved in Drive'}>
              <span className="save-state" role="status" aria-label={snap.streaming ? 'Saving…' : 'Saved to Drive'}>
                <MIcon name={snap.streaming ? 'cloud_sync' : 'cloud_done'} className={snap.streaming ? 'cloud busy' : 'cloud'} />
                {snap.streaming ? <span className="save-text">Saving…</span> : saved ? <span className="save-text">Saved to Drive</span> : null}
              </span>
            </Tip>
          </div>
          <DocMenus
            outputOnly={outputOnly}
            onToggleOutputOnly={onToggleOutputOnly}
            onNew={onNew}
            snap={snap}
            onRename={() => titleRef.current?.focus()}
            onGrid={onGrid}
            onList={onList}
          />
        </div>
        <div className="header-end">
          <DocActions snap={snap} />
          <AccountMenu snap={snap} />
        </div>
      </div>
      <Toolbar snap={snap} />
      <SideRail />
    </header>
  )
}

/** Docs shows "Saved to Drive" for a few seconds after a save finishes. */
function useSavedFlash(busy: boolean): boolean {
  const [saved, setSaved] = useState(false)
  const was = useRef(busy)
  useEffect(() => {
    if (was.current && !busy) {
      setSaved(true)
      const timer = setTimeout(() => setSaved(false), 4000)
      was.current = busy
      return () => clearTimeout(timer)
    }
    was.current = busy
  }, [busy])
  return saved
}
