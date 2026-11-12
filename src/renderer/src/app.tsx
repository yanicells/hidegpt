import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { LoadingDocument } from './components/document/LoadingDocument'
import { Banners } from './components/layout/Banners'
import { Document } from './components/document/Document'
import { DocumentChrome } from './components/document/DocumentChrome'
import { createDocument } from './components/home/createDocument'
import { threadProjectId } from './components/home/projects'
import { Home } from './components/home/Home'
import { HomeHeader } from './components/home/HomeHeader'
import { useHomeView } from './components/home/useHomeView'
import { platform, useMenuAction, useShellSnapshot } from './session-bridge'
import type { MenuAction } from '../../shared/api'

export function App() {
  // Streamed text re-renders only the document, which reads its blocks itself.
  const snap = useShellSnapshot()
  // Tool activity is hidden unless View → "Show non-printing characters" turns it on.
  const [outputOnly, setOutputOnly] = useState(() => localStorage.getItem('hidegpt-output-only') !== 'false')
  const toggleOutputOnly = () =>
    setOutputOnly((current) => {
      localStorage.setItem('hidegpt-output-only', String(!current))
      return !current
    })
  const [location, setLocation] = useState({ provider: snap.provider, id: 'all' })
  const projectId = location.provider === snap.provider ? location.id : 'all'
  const activeThread = snap.threads.find((thread) => snap.route.kind === 'doc' && thread.id === snap.route.threadId)
  const activeProjectId = activeThread
    ? (threadProjectId(snap, activeThread) ?? undefined)
    : projectId === 'all'
      ? undefined
      : projectId
  // One stable callback that reads the latest snapshot, so the memoized Tabs panel
  // and the menu listener never re-render or re-register when a new snapshot lands.
  const latest = useRef({ snap, activeProjectId })
  useLayoutEffect(() => {
    latest.current = { snap, activeProjectId }
  })
  const onNew = useCallback(() => void createDocument(latest.current.snap, latest.current.activeProjectId), [])
  const [view, setView] = useHomeView()
  const titleRef = useRef<HTMLInputElement>(null)
  const onMenu = useCallback(
    (action: MenuAction) => {
      if (action === 'newDocument') onNew()
      if (action === 'rename') {
        titleRef.current?.focus()
        titleRef.current?.select()
      }
      if (action === 'grid') setView('grid')
      if (action === 'list') setView('list')
      if (action === 'focusSearch') {
        document.querySelector<HTMLInputElement>('[data-testid="home-search"]')?.focus()
      }
    },
    [onNew, setView],
  )
  useMenuAction(onMenu)

  return (
    <div data-testid="app" className={`app platform-${platform()} route-${snap.route.kind}`}>
      {snap.route.kind === 'home' ? (
        <HomeHeader key={`header-${snap.provider}`} snap={snap} />
      ) : (
        <DocumentChrome
          outputOnly={outputOnly}
          onToggleOutputOnly={toggleOutputOnly}
          onNew={onNew}
          snap={snap}
          titleRef={titleRef}
          onGrid={() => setView('grid')}
          onList={() => setView('list')}
        />
      )}
      <Banners snap={snap} />
      {/* Errors show on the banner above; the page underneath stays usable. */}
      {snap.openingThreadId ? (
        <LoadingDocument snap={snap} />
      ) : snap.route.kind === 'home' ? (
        <Home
          projectId={projectId}
          onProject={(id) => setLocation({ provider: snap.provider, id })}
          key={snap.provider}
          onCreate={(template) => void createDocument(snap, activeProjectId, template)}
          snap={snap}
          view={view}
          onView={setView}
        />
      ) : (
        // One instance per document, so its scroll, rows and follow state start fresh.
        <Document key={snap.route.threadId} outputOnly={outputOnly} onNew={onNew} snap={snap} />
      )}
    </div>
  )
}
