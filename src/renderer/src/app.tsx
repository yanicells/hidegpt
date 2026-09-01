import { useCallback, useRef } from 'react'

import { Banners } from './chrome'
import { Document, DocumentChrome } from './document'
import { Home, HomeHeader, useHomeView } from './home'
import { dispatch, platform, useMenuAction, useSnapshot } from './session-bridge'

export function App() {
  const snap = useSnapshot()
  const [view, setView] = useHomeView()
  const titleRef = useRef<HTMLInputElement>(null)
  const searchFocus = useCallback((action: 'rename' | 'grid' | 'list' | 'newDocument' | 'goHome' | 'focusSearch') => {
    if (action === 'rename') titleRef.current?.focus()
    if (action === 'grid') setView('grid')
    if (action === 'list') setView('list')
    if (action === 'focusSearch') {
      document.querySelector<HTMLInputElement>('[data-testid="home-search"]')?.focus()
    }
  }, [setView])
  useMenuAction(searchFocus)

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
