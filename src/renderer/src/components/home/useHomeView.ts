import { useCallback, useState } from 'react'

export type HomeView = 'grid' | 'list'

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
    }
  }, [])
  return [view, update]
}
