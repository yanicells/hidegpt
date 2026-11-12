import { memo } from 'react'

import { formatListDate, previewLines, threadTitle } from '../../../../shared/labels'
import { dispatch } from '../../session-bridge'
import { DocFileIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'
import { Menu, MenuTrigger } from '../ui/menu'
import { MenuPanel, type Item } from '../ui/MenuPanel'
import type { Thread } from './grouping'

const open = (thread: Thread) => dispatch({ op: 'openThread', threadId: thread.id })

/**
 * A recent document as Docs' card: a thumbnail of its first page, then title
 * and date. The page opens with the first question as its Heading 1, so the
 * thumbnail does too. The title button stretches over the whole card, so a
 * click anywhere opens the document except on the ⋮ menu above it.
 * Memoized: thread objects keep their identity across snapshot patches.
 */
export const DocCard = memo(function DocCard({ thread }: { thread: Thread }) {
  const title = threadTitle(thread)
  const [heading, ...rest] = previewLines(thread.preview).split('\n')
  const body = rest.join('\n').trim()
  return (
    <div className="doc-card">
      <div className="thumb" aria-hidden="true">
        <div className="thumb-page">
          {heading ? <span className="thumb-heading">{heading}</span> : null}
          {body ? <span className="thumb-text">{body}</span> : null}
        </div>
      </div>
      <div className="card-foot">
        <button type="button" className="card-title" data-testid={`thread-${thread.id}`} onClick={() => open(thread)}>
          {title}
        </button>
        <span className="card-meta">
          <DocFileIcon size={20} />
          {/* Docs' cards give the year even for this year ("Opened Nov 4, 2026"), like the list view. */}
          <span className="card-date">Opened {formatListDate(thread.updatedAt)}</span>
          <DocMenu thread={thread} className="card-more" size={20} />
        </span>
      </div>
    </div>
  )
})

/**
 * A document's ⋮ menu with Docs' entries. Removing and renaming from Home
 * have no command yet, so those rows show disabled; "Open in new tab" opens
 * the document (this window is the only tab); it has no icon until the set
 * gains open_in_new.
 */
export function DocMenu({ thread, className, size }: { thread: Thread; className: string; size: number }) {
  const items: Item[] = [
    { id: 'rename', label: 'Rename', icon: 'text_format', disabled: true },
    { id: 'remove', label: 'Remove', icon: 'delete', disabled: true },
    { id: 'open-new-tab', label: 'Open in new tab', run: () => open(thread) },
  ]
  return (
    <Menu>
      <MenuTrigger className={className} aria-label="More actions" data-testid={`more-${thread.id}`}>
        <MIcon name="more_vert" size={size} />
      </MenuTrigger>
      <MenuPanel items={items} itemPrefix="doc" align="end" />
    </Menu>
  )
}
