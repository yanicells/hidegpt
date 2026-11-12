import { formatListDate, ownerLabel, threadTitle } from '../../../../shared/labels'
import type { Snapshot } from '../../../../shared/model'
import { dispatch } from '../../session-bridge'
import { DocFileIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'
import type { Thread } from './grouping'

/** Docs' list view rows; column labels live in the section header above. */
export function ListView({ snap, threads }: { snap: Snapshot; threads: Thread[] }) {
  return (
    <ul className="list" aria-label="Documents">
      {threads.map((thread) => (
        <li key={thread.id}>
          <button
            type="button"
            className="list-row"
            data-testid={`thread-${thread.id}`}
            onClick={() => dispatch({ op: 'openThread', threadId: thread.id })}
          >
            <span className="list-name">
              <DocFileIcon size={24} />
              <span>{threadTitle(thread)}</span>
            </span>
            <span className="list-owner">{ownerLabel(snap.account)}</span>
            <span className="list-date">{formatListDate(thread.updatedAt)}</span>
            <span className="list-more" aria-hidden="true">
              <MIcon name="more_vert" size={24} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
