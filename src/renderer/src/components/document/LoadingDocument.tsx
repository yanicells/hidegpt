import type { Snapshot } from '../../../../shared/model'
import { SparkIcon } from '../ui/Icons'
import { PAGE_HEIGHT } from './pages'
import { Ruler, VerticalRuler } from './Rulers'
import { Tabs } from './Tabs'

const NO_ENTRIES: never[] = []
const noJump = () => {}

/**
 * The header shows the document being opened, like Docs while a file loads:
 * its name (or "Untitled document" until it has one) and its folder. The
 * header stays mounted from the click to the open page, so only the page
 * below it changes.
 */
export function openingSnapshot(snap: Snapshot): Snapshot {
  if (!snap.openingThreadId) return snap
  const thread = snap.threads.find((item) => item.id === snap.openingThreadId)
  return {
    ...snap,
    route: { kind: 'doc', threadId: snap.openingThreadId },
    title: thread?.name || 'Untitled document',
    streaming: false,
  }
}

/**
 * The editor while a document opens: rulers, the tabs panel and an empty
 * first page, laid out exactly as `Document` lays them out, so nothing moves
 * when the text arrives. The header's save area says "Opening…"; the Docs
 * logo goes back Home, which cancels the open.
 */
export function LoadingDocument({ onNew }: { onNew: () => void }) {
  return (
    <div className="workspace" aria-busy="true" data-testid="opening-document">
      <div className="doc-layout">
        <VerticalRuler />
        <Tabs onNew={onNew} entries={NO_ENTRIES} onJump={noJump} />
        <div className="paper-col">
          <Ruler />
          <article className="paper" style={{ minHeight: PAGE_HEIGHT }}>
            <div className="page-sheets" aria-hidden="true">
              <div className="page-sheet" style={{ top: 0 }} />
            </div>
          </article>
        </div>
      </div>
      <div className="spark-wrap">
        <span className="spark-pill" aria-hidden="true">
          <SparkIcon size={16} mono />
        </span>
      </div>
    </div>
  )
}
