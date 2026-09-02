import { useEffect, useMemo, useRef, useState } from 'react'

import {
  formatOpened,
  ownerLabel,
  previewLines,
  threadTitle,
} from '../../codex/labels'
import type { Snapshot } from '../../codex/types'
import { DocsIcon, DocsMark, GridIcon, ListIcon, PlusIcon, SearchIcon } from './icons'
import { AccountMenu } from './chrome'
import { dispatch } from './session-bridge'

export type HomeView = 'grid' | 'list'

export function HomeHeader({ snap }: { snap: Snapshot }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
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
          value={snap.search}
          placeholder="Search documents"
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
  const grouped = useMemo(() => groupThreads(snap), [snap])

  return (
    <div className="home">
      <section className="gallery">
        <div className="gallery-inner">
          <span className="gallery-title" data-testid="docs-home">
            Start a new document
          </span>
          <div className="template">
            <button
              type="button"
              className="template-card"
              data-testid="new-doc"
              onClick={() => dispatch({ op: 'newDocument' })}
            >
              <PlusIcon />
            </button>
            <span className="template-label">Blank</span>
          </div>
        </div>
      </section>
      <section className="recent">
        {grouped.map((section) => (
          <div key={section.key} className={section.key === 'recent' ? undefined : 'section-gap'}>
            <div className="recent-inner">
              <div className="recent-head">
                <span className="recent-title">{section.title}</span>
                {section.key === 'recent' ? (
                  <div className="view-toggle">
                    <button
                      type="button"
                      className={`view-btn${view === 'list' ? ' active' : ''}`}
                      aria-label="List view"
                      onClick={() => onView('list')}
                    >
                      <ListIcon active={view === 'list'} />
                    </button>
                    <button
                      type="button"
                      className={`view-btn${view === 'grid' ? ' active' : ''}`}
                      aria-label="Grid view"
                      onClick={() => onView('grid')}
                    >
                      <GridIcon active={view === 'grid'} />
                    </button>
                  </div>
                ) : null}
              </div>
              {section.threads.length === 0 ? (
                <p className="empty">
                  {snap.status === 'connecting'
                    ? 'Opening…'
                    : snap.threads.length === 0
                      ? 'No documents yet'
                      : snap.search.trim()
                        ? 'No matching documents'
                        : 'All documents are in folders'}
                </p>
              ) : view === 'list' && section.key === 'recent' ? (
                <ListView snap={snap} threads={section.threads} />
              ) : (
                <div className="doc-grid">
                  {section.threads.map((thread) => (
                    <DocCard key={thread.id} snap={snap} thread={thread} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}

function ListView({
  snap,
  threads,
}: {
  snap: Snapshot
  threads: Snapshot['threads']
}) {
  return (
    <div className="list">
      <div className="list-head">
        <span>Name</span>
        <span>Owner</span>
        <span>Last opened</span>
      </div>
      {threads.map((thread) => (
        <button
          type="button"
          key={thread.id}
          className="list-row"
          data-testid={`thread-${thread.id}`}
          onClick={() => dispatch({ op: 'openThread', threadId: thread.id })}
        >
          <span className="list-name">
            <DocsMark size={24} />
            <span>{threadTitle(thread)}</span>
          </span>
          <span className="list-owner">{ownerLabel(snap.account)}</span>
          <span className="list-date">{formatOpened(thread.recencyAt ?? thread.updatedAt)}</span>
        </button>
      ))}
    </div>
  )
}

function DocCard({
  snap,
  thread,
}: {
  snap: Snapshot
  thread: Snapshot['threads'][number]
}) {
  const title = threadTitle(thread)
  const preview = previewLines(thread.preview || title)
  return (
    <button
      type="button"
      className="doc-card"
      data-testid={`thread-${thread.id}`}
      onClick={() => dispatch({ op: 'openThread', threadId: thread.id })}
    >
      <div className="thumb">
        <div className="thumb-bar" />
        <div className="thumb-body">{preview}</div>
      </div>
      <span className="card-title">{title}</span>
      <span className="card-meta">
        Opened {formatOpened(thread.recencyAt ?? thread.updatedAt)}
        {snap.account ? ` · ${ownerLabel(snap.account)}` : ''}
      </span>
    </button>
  )
}

function groupThreads(snap: Snapshot) {
  const query = snap.search.trim().toLowerCase()
  const visible = query
    ? snap.threads.filter((thread) => `${thread.name ?? ''} ${thread.preview}`.toLowerCase().includes(query))
    : snap.threads
  const byProject = new Map<string, Snapshot['threads']>()
  const loose: Snapshot['threads'] = []
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
  const sections: Array<{ key: string; title: string; threads: Snapshot['threads'] }> = [
    ...snap.projects.map((project) => ({
      key: `p-${project.id}`,
      title: project.name,
      threads: byProject.get(project.id) ?? [],
    })),
    ...orphans.map(([id, threads]) => ({ key: `orphan-${id}`, title: 'Folder', threads })),
    { key: 'recent', title: 'Recent documents', threads: loose },
  ]
  return sections.filter((section) => section.threads.length > 0 || section.key === 'recent')
}

export function useHomeView(): [HomeView, (view: HomeView) => void] {
  const [view, setView] = useState<HomeView>(() => {
    try {
      return localStorage.getItem('hidegpt.homeView') === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  return [
    view,
    (next) => {
      setView(next)
      try {
        localStorage.setItem('hidegpt.homeView', next)
      } catch {
        // ignore
      }
    },
  ]
}
