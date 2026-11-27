import { memo } from 'react'

import { formatListDate, threadTitle } from '../../../../shared/labels'
import { dispatch } from '../../session-bridge'
import { DocFileIcon } from '../ui/Icons'
import { DocMenu } from './DocCard'
import type { Thread } from './grouping'

/**
 * Docs' list view rows; column labels live in the section header above.
 * `owner` is the owner column's text. Memoized, like its rows: thread objects
 * and Home's sections keep their identity across snapshot patches.
 */
export const ListView = memo(function ListView({ owner, threads }: { owner: string; threads: Thread[] }) {
  return (
    <ul className="list" aria-label="Documents">
      {threads.map((thread) => (
        <ListRow key={thread.id} owner={owner} thread={thread} />
      ))}
    </ul>
  )
})

/**
 * One document row. The name button stretches over the row, so a click
 * anywhere opens the document except on the ⋮ menu above it.
 */
const ListRow = memo(function ListRow({ owner, thread }: { owner: string; thread: Thread }) {
  return (
    <li>
      <div className="list-row">
        <span className="list-name">
          <DocFileIcon size={24} />
          <button
            type="button"
            className="list-open"
            data-testid={`thread-${thread.id}`}
            onClick={() => dispatch({ op: 'openThread', threadId: thread.id })}
          >
            {threadTitle(thread)}
          </button>
        </span>
        <span className="list-owner">{owner}</span>
        <span className="list-date">{formatListDate(thread.updatedAt)}</span>
        <DocMenu thread={thread} className="list-more" size={24} />
      </div>
    </li>
  )
})
