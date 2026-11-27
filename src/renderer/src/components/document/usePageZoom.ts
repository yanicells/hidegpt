import { useEffect, useState } from 'react'

/** Page zoom shared with the document canvas through a CSS variable; persists. */
export function usePageZoom(): [number, (value: number) => void] {
  const [zoom, setZoom] = useState(() => {
    try {
      return Number(localStorage.getItem('hidegpt.zoom')) || 100
    } catch {
      return 100
    }
  })
  useEffect(() => {
    document.documentElement.style.setProperty('--page-zoom', String(zoom / 100))
    try {
      localStorage.setItem('hidegpt.zoom', String(zoom))
    } catch {
      // Private storage: zoom just resets next launch.
    }
  }, [zoom])
  return [zoom, setZoom]
}

/** "Fit": the largest zoom (≤100%) that shows the whole page width. */
export function fitZoom(): number {
  const area = document.querySelector<HTMLElement>('.paper-col')
  if (!area) return 100
  return Math.max(50, Math.min(100, Math.floor(((area.clientWidth - 32) / 816) * 100)))
}
