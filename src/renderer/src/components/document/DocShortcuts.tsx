import { useEffect, useState } from 'react'

import { platform } from '../../session-bridge'
import { matchesShortcut, SHORTCUTS, shortcutLabel, type Shortcut } from '../../shortcuts'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '../ui/dialog'
import { MIcon } from '../ui/MaterialIcon'

/** The shortcuts that work in this window, under Docs' names. */
const LISTED: ReadonlyArray<readonly [string, Shortcut]> = [
  ['Copy', { key: 'c', mod: true }],
  ['Paste', { key: 'v', mod: true }],
  ['Undo', { key: 'z', mod: true }],
  ['Redo', { key: 'z', mod: true, shift: true }],
  ['Find', SHORTCUTS.find],
  ['Print', SHORTCUTS.print],
  ['Show common keyboard shortcuts', SHORTCUTS.help],
]

/**
 * The document's own keys: Cmd+P prints the page (print.css drops the chrome)
 * and Cmd+/ opens Docs' "Keyboard shortcuts" list. Find comes from the native
 * menu instead (FindBar). Mount once per document.
 */
export function DocShortcuts() {
  const [helpOpen, setHelpOpen] = useState(false)
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

  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogPopup className="shortcuts-dialog" data-testid="shortcuts-dialog">
        <div className="shortcuts-head">
          <DialogTitle render={<h2 />}>Keyboard shortcuts</DialogTitle>
          <DialogClose className="shortcuts-close" aria-label="Close">
            <MIcon name="close" size={24} />
          </DialogClose>
        </div>
        <h3 className="shortcuts-section">Common actions</h3>
        <dl className="shortcuts-list">
          {LISTED.map(([name, shortcut]) => (
            <div className="shortcuts-row" key={name}>
              <dt>{name}</dt>
              <dd>{shortcutLabel(shortcut, os)}</dd>
            </div>
          ))}
        </dl>
      </DialogPopup>
    </Dialog>
  )
}
