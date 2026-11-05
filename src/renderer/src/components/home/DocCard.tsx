import { memo } from 'react'

import { formatListDate, previewLines, threadTitle } from '../../../../codex/labels'
import { dispatch } from '../../session-bridge'
import { DocFileIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'
import type { Thread } from './grouping'

/**
 * A recent document as Docs' card: a thumbnail of its first page, then title
 * and date. The page opens with the first question as its Heading 1, so the
 * thumbnail does too. Memoized: thread objects keep their identity across
 * snapshot patches.
 */
export const DocCard = memo(function DocCard({ thread }: { thread: Thread }) {
  const title = threadTitle(thread)
  const [heading, ...rest] = previewLines(thread.preview).split('\n')
  const body = rest.join('\n').trim()
  return (
    <button
      type="button"
      className="doc-card"
      data-testid={`thread-${thread.id}`}
      onClick={() => dispatch({ op: 'openThread', threadId: thread.id })}
    >
      <div className="thumb" aria-hidden="true">
        <div className="thumb-page">
          {heading ? <span className="thumb-heading">{heading}</span> : null}
          {body ? <span className="thumb-text">{body}</span> : null}
        </div>
      </div>
      <div className="card-foot">
        <span className="card-title">{title}</span>
        <span className="card-meta">
          <DocFileIcon size={20} />
          {/* Docs' cards give the year even for this year ("Opened Nov 4, 2026"), like the list view. */}
          <span className="card-date">Opened {formatListDate(thread.recencyAt ?? thread.updatedAt)}</span>
          <span className="card-more" aria-hidden="true">
            <MIcon name="more_vert" />
          </span>
        </span>
      </div>
    </button>
  )
})
