import { useMemo } from 'react'

import type { Snapshot } from '../../../../codex/types'
import { TEMPLATES } from '../../templates'
import { FolderIcon, GridIcon, ListIcon } from '../ui/Icons'
import { DocCard } from './DocCard'
import { groupThreads } from './grouping'
import { ListView } from './ListView'
import { TemplateCard } from './TemplateCard'
import type { HomeView } from './useHomeView'

export function Home({
  snap,
  view,
  onView,
}: {
  snap: Snapshot
  view: HomeView
  onView: (view: HomeView) => void
}) {
  const sections = useMemo(() => groupThreads(snap, view), [snap, view])
  const loading = snap.status === 'connecting' && snap.threads.length === 0

  return (
    <div className="home">
      <section className="gallery">
        <div className="gallery-inner">
          <div className="gallery-head">
            <span className="section-title" data-testid="docs-home">
              Start a new document
            </span>
          </div>
          <div className="template-strip">
            {TEMPLATES.map((template) => (
              <TemplateCard key={template.id} template={template} />
            ))}
          </div>
        </div>
      </section>
      <section className="recent">
        {sections.map((section, index) => (
          <div key={section.key} className="recent-inner">
            <div className="recent-head">
              <span className="section-title">
                {section.kind === 'folder' ? <FolderIcon /> : null}
                {section.title}
              </span>
              {section.kind === 'recent' && index === 0 ? (
                <div className="view-toggle" role="group" aria-label="Layout">
                  <button
                    type="button"
                    className={`icon-btn${view === 'list' ? ' active' : ''}`}
                    aria-label="List view"
                    aria-pressed={view === 'list'}
                    onClick={() => onView('list')}
                  >
                    <ListIcon />
                  </button>
                  <button
                    type="button"
                    className={`icon-btn${view === 'grid' ? ' active' : ''}`}
                    aria-label="Grid view"
                    aria-pressed={view === 'grid'}
                    onClick={() => onView('grid')}
                  >
                    <GridIcon />
                  </button>
                </div>
              ) : null}
            </div>
            {loading ? (
              <SkeletonGrid />
            ) : section.threads.length === 0 ? (
              <EmptyState search={snap.search} />
            ) : view === 'list' ? (
              <ListView snap={snap} threads={section.threads} />
            ) : (
              <div className="doc-grid">
                {section.threads.map((thread) => (
                  <DocCard key={thread.id} thread={thread} />
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  )
}

function SkeletonGrid() {
  return (
    <div className="doc-grid" aria-busy="true" aria-label="Loading documents">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="doc-card skeleton">
          <div className="thumb" />
          <div className="card-foot">
            <span className="card-title sk-text" />
            <span className="card-meta sk-text" />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ search }: { search: string }) {
  const query = search.trim()
  return (
    <div className="empty">
      {query ? (
        <>
          <span className="empty-title">No documents match “{query}”</span>
          <span className="empty-text">Try a different word, or clear the search to see everything.</span>
        </>
      ) : (
        <>
          <span className="empty-title">No documents yet</span>
          <span className="empty-text">Start with a blank document or one of the templates above.</span>
        </>
      )}
    </div>
  )
}
