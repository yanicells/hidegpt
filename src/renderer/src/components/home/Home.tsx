import { useState } from 'react'
import type { Snapshot } from '../../../../codex/types'
import { TEMPLATES } from '../../templates'
import { BackIcon, FolderIcon, GridIcon, ListIcon, PlusMonoIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'
import { DocCard } from './DocCard'
import { groupByRecency } from './grouping'
import { ListView } from './ListView'
import { TemplateCard } from './TemplateCard'
import { ProjectFolders, projectFolders, threadProjectId } from './ProjectFolders'
import type { Creation } from './NewDocumentDialog'
import type { HomeView } from './useHomeView'

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
  onCreate: (creation: Creation) => void
}) {
  const [sort, setSort] = useState('recent')
  const folders = projectFolders(snap)
  const project = folders.find((item) => item.id === projectId)
  const query = snap.search.trim().toLowerCase()
  const threads = snap.threads
    .filter(
      (thread) =>
        (projectId === 'all' ||
          (projectId === 'loose' ? !threadProjectId(snap, thread) : threadProjectId(snap, thread) === projectId)) &&
        (!query || `${thread.name ?? ''} ${thread.preview}`.toLowerCase().includes(query)),
    )
    .sort((a, b) =>
      sort === 'name'
        ? (a.name || a.preview).localeCompare(b.name || b.preview)
        : (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt),
    )
  const sections =
    view === 'list' && sort === 'recent' ? groupByRecency(threads) : [{ key: 'docs', title: '', threads }]
  // Like Docs' list view, the first recency group titles the whole section.
  const groupedTitle = view === 'list' && !query && !project
  const loading = snap.status === 'connecting' && !snap.threads.length
  return (
    <div className="home">
      {!project ? (
        <section className="gallery">
          <div className="gallery-inner">
            <div className="gallery-head">
              <span className="section-title" data-testid="docs-home">
                Start a new document
              </span>
              <span className="gallery-tools" aria-hidden="true">
                <span className="gallery-caption">
                  Template gallery
                  <MIcon name="unfold" />
                </span>
                <span className="gallery-divider" />
                <span className="header-icon">
                  <MIcon name="more" />
                </span>
              </span>
            </div>
            <div className="template-strip">
              {TEMPLATES.map((template) => (
                <TemplateCard key={template.id} template={template} onClick={() => onCreate({ template })} />
              ))}
            </div>
          </div>
        </section>
      ) : null}
      <main className="recent">
        <div className="recent-inner">
          {project ? (
            <div className="project-detail-heading">
              <button className="icon-btn" aria-label="All documents" onClick={() => onProject('all')}>
                <BackIcon />
              </button>
              <FolderIcon />
              <div>
                <h1>{project.name}</h1>
                <p>
                  {project.count} {project.count === 1 ? 'document' : 'documents'}
                </p>
              </div>
              <button className="primary-button" onClick={() => onCreate({ projectId: project.id })}>
                <PlusMonoIcon />
                New document
              </button>
            </div>
          ) : (
            <ProjectFolders snap={snap} onOpen={onProject} onAdd={() => onCreate({ projectOnly: true })} />
          )}
          <div className={`recent-head${view === 'list' ? ' as-list' : ''}`}>
            <span className="section-title">
              {query
                ? 'Search results'
                : project
                  ? 'Documents'
                  : groupedTitle && sections[0]?.title
                    ? sections[0].title
                    : 'Recent documents'}
            </span>
            <label className="owned-by">
              <select aria-label="Filter by project" value={projectId} onChange={(event) => onProject(event.target.value)}>
                <option value="all">All locations</option>
                <option value="loose">No project</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
              <MIcon name="dropDown" />
            </label>
            {view === 'list' ? <span className="list-col-label">Last opened by me</span> : <span />}
            <div className="recent-controls">
              {view === 'grid' ? (
                <button className="icon-btn" aria-label="List view" title="List view" onClick={() => onView('list')}>
                  <ListIcon />
                </button>
              ) : (
                <button className="icon-btn" aria-label="Grid view" title="Grid view" onClick={() => onView('grid')}>
                  <GridIcon />
                </button>
              )}
              <button
                className={`icon-btn${sort === 'name' ? ' active' : ''}`}
                aria-label="Sort by title"
                aria-pressed={sort === 'name'}
                title={sort === 'name' ? 'Sort by last opened' : 'Sort A–Z'}
                onClick={() => setSort(sort === 'name' ? 'recent' : 'name')}
              >
                <MIcon name="sortAz" />
              </button>
            </div>
          </div>
          {loading ? (
            <SkeletonGrid />
          ) : !threads.length ? (
            <>
              <EmptyState search={snap.search} />
              <button className="empty-create text-button" onClick={() => onCreate({ projectId: project?.id })}>
                Create a document
              </button>
            </>
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
