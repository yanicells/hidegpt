import { platform } from '../../session-bridge'
import { SHORTCUTS, shortcutLabel, type Shortcut } from '../../shortcuts'
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

/** Docs' "Keyboard shortcuts" list, loaded on the first Cmd+/ by DocShortcuts. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const os = platform()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
