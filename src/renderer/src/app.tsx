import { LoadingDocument } from './components/document/LoadingDocument'
import { NewDocumentDialog, type Creation } from './components/home/NewDocumentDialog'
import { useCallback, useRef, useState } from 'react'

import { Banners } from './components/layout/Banners'
import { Document } from './components/document/Document'
import { DocumentChrome } from './components/document/DocumentChrome'
import { threadProjectId } from './components/home/ProjectFolders'
import { Home } from './components/home/Home'
import { HomeHeader } from './components/home/HomeHeader'
import { useHomeView } from './components/home/useHomeView'
import { dispatch, platform, useMenuAction, useSnapshot } from './session-bridge'
import type { MenuAction } from '../../shared/api'

export function App() {
  const snap = useSnapshot()
  const [outputOnly, setOutputOnly] = useState(() => localStorage.getItem('hidegpt-output-only') === 'true')
  const toggleOutputOnly = () =>
    setOutputOnly((current) => {
      localStorage.setItem('hidegpt-output-only', String(!current))
      return !current
    })
  const [location, setLocation] = useState({ provider: snap.provider, id: 'all' })
  const projectId = location.provider === snap.provider ? location.id : 'all'
  const [creation, setCreation] = useState<Creation | null>(null)
  const activeThread = snap.threads.find((thread) => snap.route.kind === 'doc' && thread.id === snap.route.threadId)
  const activeProjectId = activeThread
    ? (threadProjectId(snap, activeThread) ?? undefined)
    : projectId === 'all' || projectId === 'loose'
      ? undefined
      : projectId
  const onNew = () => setCreation({ projectId: activeProjectId })
  const [view, setView] = useHomeView()
  const titleRef = useRef<HTMLInputElement>(null)
  const onMenu = useCallback(
    (action: MenuAction) => {
      if (action === 'newDocument') setCreation({ projectId: activeProjectId })
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
    [setView, activeProjectId],
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
      {snap.status === 'error' ? (
        <button type="button" className="status" data-testid="status" onClick={() => dispatch({ op: 'refresh' })}>
          {snap.error ?? 'Something went wrong'}
        </button>
      ) : snap.openingThreadId ? (
        <LoadingDocument snap={snap} />
      ) : snap.route.kind === 'home' ? (
        <Home
          projectId={projectId}
          onProject={(id) => setLocation({ provider: snap.provider, id })}
          key={snap.provider}
          onCreate={setCreation}
          snap={snap}
          view={view}
          onView={setView}
        />
      ) : (
        <Document outputOnly={outputOnly} onNew={onNew} snap={snap} />
      )}
      {creation ? (
        <NewDocumentDialog
          key={`creation-${snap.provider}`}
          snap={snap}
          creation={creation}
          onClose={() => setCreation(null)}
        />
      ) : null}
    </div>
  )
}
