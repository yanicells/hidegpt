import { useState } from 'react'

import type { Snapshot } from '../../../../shared/model'
import { TEMPLATES, type Template } from '../../templates'
import { MIcon } from '../ui/MaterialIcon'
import { Tip } from '../ui/tooltip'
import { DocCard } from './DocCard'
import { FolderPicker } from './FolderPicker'
import { groupByRecency } from './grouping'
import { ListView } from './ListView'
import { OwnerMenu, type Owner } from './OwnerMenu'
import { projectFolders, threadProjectId } from './projects'
import { TemplateCard } from './TemplateCard'
import type { HomeView } from './useHomeView'

/**
 * Docs home: template band plus recent documents. Projects are Drive folders:
 * pick one from the folder icon's file picker and the section takes its name;
 * "Blank document" then creates inside it. "Owned by anyone" goes back to all.
 */
export function Home({
  snap,
  view,
  onView,
  onCreate,
  projectId,
  onProject,
}: {
  projectId: string
  onProject: (id: string) => void
  snap: Snapshot
  view: HomeView
  onView: (view: HomeView) => void
  onCreate: (template?: Template) => void
}) {
  const [sort, setSort] = useState('recent')
  const [picker, setPicker] = useState(false)
  const [owner, setOwner] = useState<Owner>('anyone')
  const folders = projectFolders(snap)
  const folder = folders.find((item) => item.id === projectId)
  const query = snap.search.trim().toLowerCase()
  const threads = snap.threads
    .filter(
      (thread) =>
        owner !== 'others' &&
        (projectId === 'all' || threadProjectId(snap, thread) === projectId) &&
        (!query || `${thread.name ?? ''} ${thread.preview}`.toLowerCase().includes(query)),
    )
    .sort((a, b) =>
      sort === 'name' ? (a.name || a.preview).localeCompare(b.name || b.preview) : b.updatedAt - a.updatedAt,
    )
  const sections =
    view === 'list' && sort === 'recent' ? groupByRecency(threads) : [{ key: 'docs', title: '', threads }]
  // Like Docs' list view, the first recency group titles the whole section.
  const groupedTitle = view === 'list' && !query && !folder
  const loading = snap.status === 'connecting' && !snap.threads.length
  return (
    <div className="home">
      <section className="gallery">
        <div className="gallery-inner">
          <div className="gallery-head">
            <span className="section-title" data-testid="docs-home">
              Start a new document
            </span>
            <span className="gallery-tools" aria-hidden="true">
              <span className="gallery-caption">
                Template gallery
                <MIcon name="unfold_more" />
              </span>
              <span className="gallery-divider" />
              <span className="header-icon">
                <MIcon name="more_vert" size={24} />
              </span>
            </span>
          </div>
          <div className="template-strip">
            {TEMPLATES.map((template) => (
              <TemplateCard key={template.id} template={template} onClick={() => onCreate(template)} />
            ))}
          </div>
        </div>
      </section>
      <main className="recent">
        <div className="recent-inner">
          <div className={`recent-head${view === 'list' ? ' as-list' : ''}`}>
            <span className="section-title" data-testid="recent-title">
              {query
                ? 'Search results'
                : (folder?.name ?? (groupedTitle && sections[0]?.title ? sections[0].title : 'Recent documents'))}
            </span>
            <OwnerMenu
              value={owner}
              onChange={(next) => {
                setOwner(next)
                onProject('all')
              }}
            />
            {view === 'list' ? <span className="list-col-label">Last opened by me</span> : <span />}
            <div className="recent-controls">
              {view === 'grid' ? (
                <Tip label="List view">
                  <button className="icon-btn" aria-label="List view" onClick={() => onView('list')}>
                    <MIcon name="view_list" size={24} />
                  </button>
                </Tip>
              ) : (
                <Tip label="Grid view">
                  <button className="icon-btn" aria-label="Grid view" onClick={() => onView('grid')}>
                    <MIcon name="view_module" size={24} />
                  </button>
                </Tip>
              )}
              <Tip label="Sort options">
                <button
                  className="icon-btn"
                  aria-label="Sort by title"
                  aria-pressed={sort === 'name'}
                  onClick={() => setSort(sort === 'name' ? 'recent' : 'name')}
                >
                  <MIcon name="sort_by_alpha" size={24} />
                </button>
              </Tip>
              <Tip label="Open file picker">
                <button
                  className="icon-btn"
                  aria-label="Open file picker"
                  data-testid="open-picker"
                  onClick={() => setPicker(true)}
                >
                  <MIcon name="folder" size={24} />
                </button>
              </Tip>
            </div>
          </div>
          {loading ? (
            <SkeletonGrid />
          ) : !threads.length ? (
            <EmptyState search={snap.search} />
          ) : (
            sections.map((section, index) => (
              <section key={section.key} className="document-section">
                {section.title && !(groupedTitle && index === 0) ? (
                  <h2 className="recency-label">{section.title}</h2>
                ) : null}
                {view === 'list' ? (
                  <ListView snap={snap} threads={section.threads} />
                ) : (
                  <div className="doc-grid">
                    {section.threads.map((thread) => (
                      <DocCard key={thread.id} thread={thread} />
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
      </main>
      {picker ? (
        <FolderPicker
          folders={folders}
          onClose={() => setPicker(false)}
          onOpen={(id) => {
            onProject(id)
            setPicker(false)
          }}
        />
      ) : null}
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
          <span className="empty-title">No results found</span>
          <span className="empty-text">Try different keywords or remove search filters.</span>
        </>
      ) : (
        <>
          <span className="empty-title">No text documents yet</span>
          <span className="empty-text">Click + to create a new document.</span>
        </>
      )}
    </div>
  )
}
