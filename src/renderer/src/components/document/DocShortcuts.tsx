import { lazy, Suspense, useEffect, useState } from 'react'

import { platform } from '../../session-bridge'
import { matchesShortcut, SHORTCUTS } from '../../shortcuts'

// The list loads on the first Cmd+/, keeping it out of the entry chunk.
const ShortcutsDialog = lazy(() => import('./ShortcutsDialog').then((module) => ({ default: module.ShortcutsDialog })))

/**
 * The document's own keys: Cmd+P prints the page (print.css drops the chrome)
 * and Cmd+/ opens Docs' "Keyboard shortcuts" list. Find comes from the native
 * menu instead (FindBar). Mount once per document.
 */
export function DocShortcuts() {
  // null until the first Cmd+/, so the list is not loaded before anyone asks for it.
  const [helpOpen, setHelpOpen] = useState<boolean | null>(null)
  const os = platform()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (matchesShortcut(event, SHORTCUTS.print, os)) {
        event.preventDefault()
        window.print()
      } else if (matchesShortcut(event, SHORTCUTS.help, os)) {
        event.preventDefault()
        setHelpOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [os])

  if (helpOpen === null) return null
  return (
    <Suspense fallback={null}>
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </Suspense>
  )
}
