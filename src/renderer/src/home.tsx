import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { formatListDate, formatOpened, ownerLabel, previewLines, threadTitle } from '../../codex/labels'
import type { Snapshot } from '../../codex/types'
import { AccountMenu } from './chrome'
import { DocsIcon, DocsMark, FolderIcon, GridIcon, KebabIcon, ListIcon, PlusIcon, SearchIcon } from './icons'
import { dispatch } from './session-bridge'
import { TEMPLATES, setPendingDraft, type Template } from './templates'

export type HomeView = 'grid' | 'list'

type Thread = Snapshot['threads'][number]

export function HomeHeader({ snap }: { snap: Snapshot }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return (
    <header className="home-header">
      <div className="brand">
        <DocsIcon size={40} />
        <span className="brand-name">Docs</span>
      </div>
      <label className="search">
        <SearchIcon />
        <input
          data-testid="home-search"
          type="search"
          value={snap.search}
          placeholder="Search documents"
          aria-label="Search documents"
          onChange={(event) => {
            dispatch({ op: 'setSearch', value: event.target.value })
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => dispatch({ op: 'applySearch' }), 300)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') dispatch({ op: 'applySearch' })
          }}
        />
      </label>
      <div className="header-end">
        <AccountMenu snap={snap} />
      </div>
    </header>
  )
}

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

function TemplateCard({ template }: { template: Template }) {
  const blank = template.id === 'blank'
  return (
    <div className="template">
      <button
        type="button"
        className={`template-card${blank ? ' blank' : ''}`}
        data-testid={blank ? 'new-doc' : `template-${template.id}`}
        aria-label={blank ? 'Blank document' : `${template.title} template`}
        onClick={() => {
          setPendingDraft(template.prompt)
          dispatch({ op: 'newDocument' })
        }}
      >
        {blank ? <PlusIcon /> : <PageSketch sketch={template.sketch} />}
      </button>
      <span className="template-title">{blank ? 'Blank document' : template.title}</span>
      {template.category ? <span className="template-category">{template.category}</span> : null}
    </div>
  )
}

type Stroke = { k: 'title' | 'sub' | 'h' | 'line' | 'bullet' | 'box' | 'table' | 'right' | 'gap'; w?: number }

const SKETCHES: Record<Template['sketch'], Stroke[]> = {
  blank: [],
  essay: [
    { k: 'title', w: 62 },
    { k: 'gap' },
    { k: 'line', w: 100 },
    { k: 'line', w: 96 },
    { k: 'line', w: 100 },
    { k: 'line', w: 58 },
    { k: 'gap' },
    { k: 'line', w: 100 },
    { k: 'line', w: 92 },
    { k: 'line', w: 100 },
    { k: 'line', w: 74 },
  ],
  notes: [
    { k: 'title', w: 54 },
    { k: 'gap' },
    { k: 'h', w: 40 },
    { k: 'bullet', w: 70 },
    { k: 'bullet', w: 56 },
    { k: 'bullet', w: 64 },
    { k: 'gap' },
    { k: 'h', w: 34 },
    { k: 'bullet', w: 60 },
    { k: 'bullet', w: 48 },
  ],
  guide: [
    { k: 'title', w: 58 },
    { k: 'gap' },
    { k: 'h', w: 30 },
    { k: 'line', w: 100 },
    { k: 'line', w: 82 },
    { k: 'gap' },
    { k: 'box' },
    { k: 'gap' },
    { k: 'h', w: 36 },
    { k: 'line', w: 90 },
  ],
  report: [
    { k: 'title', w: 66 },
    { k: 'sub', w: 40 },
    { k: 'gap' },
    { k: 'h', w: 28 },
    { k: 'line', w: 100 },
    { k: 'line', w: 88 },
    { k: 'gap' },
    { k: 'table' },
    { k: 'gap' },
    { k: 'line', w: 94 },
  ],
  letter: [
    { k: 'right', w: 38 },
    { k: 'gap' },
    { k: 'line', w: 34 },
    { k: 'line', w: 48 },
    { k: 'gap' },
    { k: 'gap' },
    { k: 'line', w: 100 },
    { k: 'line', w: 100 },
    { k: 'line', w: 92 },
    { k: 'gap' },
    { k: 'line', w: 100 },
    { k: 'line', w: 64 },
  ],
}

function PageSketch({ sketch }: { sketch: Template['sketch'] }) {
  return (
    <div className="sketch" aria-hidden="true">
      {SKETCHES[sketch].map((stroke, index) => (
        <i
          key={index}
          className={`sk sk-${stroke.k}`}
          style={stroke.w ? { width: `${stroke.w}%` } : undefined}
        />
      ))}
    </div>
  )
}

function DocCard({ thread }: { thread: Thread }) {
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
          <DocsMark size={16} />
          <span>Opened {formatOpened(thread.recencyAt ?? thread.updatedAt)}</span>
        </span>
      </div>
    </button>
  )
}

function ListView({ snap, threads }: { snap: Snapshot; threads: Thread[] }) {
  return (
    <div className="list" role="table" aria-label="Documents">
      <div className="list-head" role="row">
        <span role="columnheader">Name</span>
        <span role="columnheader">Owned by</span>
        <span role="columnheader">Last opened</span>
      </div>
      {threads.map((thread) => (
        <div key={thread.id} className="list-row-wrap">
          <button
            type="button"
            className="list-row"
            role="row"
            data-testid={`thread-${thread.id}`}
            onClick={() => dispatch({ op: 'openThread', threadId: thread.id })}
          >
            <span className="list-name" role="cell">
              <DocsMark size={22} />
              <span>{threadTitle(thread)}</span>
            </span>
            <span className="list-owner" role="cell">
              {ownerLabel(snap.account)}
            </span>
            <span className="list-date" role="cell">
              {formatListDate(thread.recencyAt ?? thread.updatedAt)}
            </span>
          </button>
          <button
            type="button"
            className="icon-btn row-more"
            aria-label={`More actions for ${threadTitle(thread)}`}
            onClick={() => dispatch({ op: 'openThread', threadId: thread.id })}
          >
            <KebabIcon />
          </button>
        </div>
      ))}
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

type Section = { key: string; title: string; kind: 'recent' | 'folder'; threads: Thread[] }

/** Loose docs group like real Docs: grid stays one shelf, list splits by recency. */
function groupThreads(snap: Snapshot, view: HomeView): Section[] {
  const query = snap.search.trim().toLowerCase()
  const visible = query
    ? snap.threads.filter((thread) => `${thread.name ?? ''} ${thread.preview}`.toLowerCase().includes(query))
    : snap.threads
  const byProject = new Map<string, Thread[]>()
  const loose: Thread[] = []
  for (const thread of visible) {
    if (thread.projectId) {
      const list = byProject.get(thread.projectId) ?? []
      list.push(thread)
      byProject.set(thread.projectId, list)
    } else {
      loose.push(thread)
    }
  }
  const known = new Set(snap.projects.map((project) => project.id))
  const orphans = [...byProject.entries()].filter(([id]) => !known.has(id))
  const recent: Section[] =
    view === 'list'
      ? groupByRecency(loose)
      : [{ key: 'recent', title: 'Recent documents', kind: 'recent', threads: loose }]
  const sections: Section[] = [
    ...recent,
    ...snap.projects.map((project) => ({
      key: `p-${project.id}`,
      title: project.name,
      kind: 'folder' as const,
      threads: byProject.get(project.id) ?? [],
    })),
    ...orphans.map(([id, threads]) => ({ key: `orphan-${id}`, title: 'Folder', kind: 'folder' as const, threads })),
  ]
  return sections.filter((section) => section.threads.length > 0 || section.kind === 'recent')
}

function groupByRecency(threads: Thread[]): Section[] {
  const buckets: Record<string, Thread[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 days': [],
    'Previous 30 days': [],
    Older: [],
  }
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  for (const thread of threads) {
    const at = (thread.recencyAt ?? thread.updatedAt ?? 0) * 1000
    const age = startOfToday - new Date(at).setHours(0, 0, 0, 0)
    if (age <= 0) buckets.Today.push(thread)
    else if (age <= day) buckets.Yesterday.push(thread)
    else if (age <= 7 * day) buckets['Previous 7 days'].push(thread)
    else if (age <= 30 * day) buckets['Previous 30 days'].push(thread)
    else buckets.Older.push(thread)
  }
  return Object.entries(buckets)
    .filter(([, items]) => items.length > 0)
    .map(([title, items]) => ({ key: `recent-${title}`, title, kind: 'recent' as const, threads: items }))
}

export function useHomeView(): [HomeView, (view: HomeView) => void] {
  const [view, setView] = useState<HomeView>(() => {
    try {
      return localStorage.getItem('hidegpt.homeView') === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const update = useCallback((next: HomeView) => {
    setView(next)
    try {
      localStorage.setItem('hidegpt.homeView', next)
    } catch {
      // ignore
    }
  }, [])
  return [view, update]
}
