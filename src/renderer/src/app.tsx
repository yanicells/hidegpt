import { useCallback, useRef } from 'react'

import { Banners } from './components/layout/Banners'
import { Document } from './components/document/Document'
import { DocumentChrome } from './components/document/DocumentChrome'
import { Home } from './components/home/Home'
import { HomeHeader } from './components/home/HomeHeader'
import { useHomeView } from './components/home/useHomeView'
import { dispatch, platform, useMenuAction, useSnapshot } from './session-bridge'
import type { MenuAction } from '../../shared/api'

export function App() {
  const snap = useSnapshot()
  const [view, setView] = useHomeView()
  const titleRef = useRef<HTMLInputElement>(null)
  const onMenu = useCallback(
    (action: MenuAction) => {
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
    [setView],
  )
  useMenuAction(onMenu)

  return (
    <div data-testid="app" className={`app platform-${platform()} route-${snap.route.kind}`}>
      {snap.route.kind === 'home' ? (
        <HomeHeader snap={snap} />
      ) : (
        <DocumentChrome snap={snap} titleRef={titleRef} onGrid={() => setView('grid')} onList={() => setView('list')} />
      )}
      <Banners snap={snap} />
      {snap.status === 'error' ? (
        <button type="button" className="status" data-testid="status" onClick={() => dispatch({ op: 'refresh' })}>
          {snap.error ?? 'Something went wrong'}
        </button>
      ) : snap.route.kind === 'home' ? (
        <Home snap={snap} view={view} onView={setView} />
      ) : (
        <Document snap={snap} />
      )}
    </div>
  )
}
