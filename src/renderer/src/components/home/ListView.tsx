import { formatListDate, ownerLabel, threadTitle } from '../../../../shared/labels'
import type { Snapshot } from '../../../../shared/model'
import { dispatch } from '../../session-bridge'
import { DocFileIcon } from '../ui/Icons'
import { DocMenu } from './DocCard'
import type { Thread } from './grouping'

/**
 * Docs' list view rows; column labels live in the section header above. The
 * name button stretches over the row, so a click anywhere opens the document
 * except on the ⋮ menu above it.
 */
export function ListView({ snap, threads }: { snap: Snapshot; threads: Thread[] }) {
  return (
    <ul className="list" aria-label="Documents">
      {threads.map((thread) => (
        <li key={thread.id}>
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
            <span className="list-owner">{ownerLabel(snap.account)}</span>
            <span className="list-date">{formatListDate(thread.updatedAt)}</span>
            <DocMenu thread={thread} className="list-more" size={24} />
          </div>
        </li>
      ))}
    </ul>
  )
}
