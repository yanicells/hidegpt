import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { DocsIcon } from '../ui/Icons'

export function LoadingDocument({ snap }: { snap: Snapshot }) {
  const thread = snap.threads.find((item) => item.id === snap.openingThreadId)
  return (
    <main className="opening-document" aria-busy="true" data-testid="opening-document">
      <div className="opening-status" role="status">
        <DocsIcon size={30} />
        <span>Opening {thread?.name || 'document'}…</span>
        <button className="text-button" onClick={() => dispatch({ op: 'goHome' })}>
          Cancel
        </button>
      </div>
      <div className="paper opening-paper" aria-hidden="true">
        {[65, 100, 92, 100, 84, 48, 100, 96, 72].map((width, i) => (
          <div key={i} className="sk-text" style={{ width: `${width}%` }} />
        ))}
      </div>
    </main>
  )
}
