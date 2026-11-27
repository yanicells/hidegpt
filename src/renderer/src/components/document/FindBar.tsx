import { lazy, Suspense, useCallback, useRef, useState } from 'react'

import type { MenuAction } from '../../../../shared/api'
import { useMenuAction } from '../../session-bridge'
import type { FindTargets } from './FindCard'

// The card, its search and its menu load on the first Cmd+F, keeping them out of the entry chunk.
const FindCard = lazy(() => import('./FindCard').then((module) => ({ default: module.FindCard })))

/**
 * Docs' "Find in document". Edit → Find (Cmd+F) opens it through the `find`
 * menu action; the page never takes the key itself. Escape or Close puts
 * focus back where Cmd+F found it. Mount once per document.
 */
export function FindBar(props: FindTargets) {
  const [open, setOpen] = useState(false)
  const [summons, setSummons] = useState(0)
  const returnFocus = useRef<HTMLElement | null>(null)

  useMenuAction(
    useCallback((action: MenuAction) => {
      if (action !== 'find') return
      const active = document.activeElement
      if (active instanceof HTMLElement && !active.closest('.find-bar')) returnFocus.current = active
      setOpen(true)
      setSummons((count) => count + 1)
    }, []),
  )

  const close = useCallback(() => {
    setOpen(false)
    const back = returnFocus.current
    returnFocus.current = null
    if (back?.isConnected) back.focus({ preventScroll: true })
  }, [])

  if (summons === 0) return null
  return (
    <Suspense fallback={null}>
      <FindCard {...props} open={open} summons={summons} onClose={close} />
    </Suspense>
  )
}
