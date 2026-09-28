import { formatListDate, ownerLabel, threadTitle } from '../../../../codex/labels'
import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { DocsIcon } from '../ui/Icons'
import type { Thread } from './grouping'

export function ListView({
  snap,
  threads,
  showHeader = true,
}: {
  snap: Snapshot
  threads: Thread[]
  showHeader?: boolean
}) {
  return (
    <div className="list" aria-label="Documents">
      {showHeader ? (
        <div className="list-head">
          <span>Name</span>
          <span>Owned by</span>
          <span>Last opened</span>
        </div>
      ) : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {threads.map((thread) => (
          <li key={thread.id}>
            <button
              type="button"
              className="list-row"
              data-testid={`thread-${thread.id}`}
              onClick={() => dispatch({ op: 'openThread', threadId: thread.id })}
            >
              <span className="list-name">
                <DocsIcon size={22} />
                <span>{threadTitle(thread)}</span>
              </span>
              <span className="list-owner">{ownerLabel(snap.account)}</span>
              <span className="list-date">{formatListDate(thread.recencyAt ?? thread.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
