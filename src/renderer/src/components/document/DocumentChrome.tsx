import { useRef, useState, type RefObject } from 'react'

import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { AccountMenu } from '../layout/AccountMenu'
import { CloudIcon, DocsIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'
import { threadProjectId } from '../home/ProjectFolders'
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
        <button type="button" className="doc-home" aria-label="Docs home" onClick={() => dispatch({ op: 'goHome' })}>
          <DocsIcon size={40} />
        </button>
        <div className="doc-head">
          <div className="doc-title-row">
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
            <span className="title-icon" aria-hidden="true">
              <MIcon name="star" />
            </span>
            <span className="document-location" title={project?.name ?? 'My documents'}>
              <MIcon name="moveFolder" />
              {project ? <small>{project.name}</small> : null}
            </span>
            <span
              className="save-state"
              role="status"
              aria-label={snap.streaming ? 'Working' : 'Saved'}
              title={snap.streaming ? 'Working…' : 'Saved'}
            >
              <CloudIcon busy={snap.streaming} />
            </span>
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
    </header>
  )
}
