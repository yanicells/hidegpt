import { memo } from 'react'

import { formatOpened, previewLines, threadTitle } from '../../../../codex/labels'
import { dispatch } from '../../session-bridge'
import { DocsIcon } from '../ui/Icons'
import type { Thread } from './grouping'

/** Memoized: thread objects keep their identity across snapshot patches. */
export const DocCard = memo(function DocCard({ thread }: { thread: Thread }) {
  const title = threadTitle(thread)
  const lines = previewLines(thread.preview)
  const body = lines.startsWith(title) ? lines.slice(title.length).trim() : lines
  return (
    <button
      type="button"
      className="doc-card"
      data-testid={`thread-${thread.id}`}
      onClick={() => dispatch({ op: 'openThread', threadId: thread.id })}
    >
      <div className="thumb" aria-hidden="true">
        <div className="thumb-page">
          <span className="thumb-title">{title}</span>
          {body ? <span className="thumb-text">{body}</span> : null}
        </div>
      </div>
      <div className="card-foot">
        <span className="card-title">{title}</span>
        <span className="card-meta">
          <DocsIcon size={16} />
          <span>Opened {formatOpened(thread.recencyAt ?? thread.updatedAt)}</span>
        </span>
      </div>
    </button>
  )
})
