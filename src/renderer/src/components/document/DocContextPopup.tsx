// The edit-flags logic (which rows apply to the right-clicked target) is adapted from
// T3 Code (apps/desktop/src/window/DesktopWindow.ts, the context-menu handler, and
// apps/web/src/contextMenuFallback.ts) at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License.

import { Menu as MenuPrimitive } from '@base-ui/react/menu'

import { platform } from '../../session-bridge'
import { shortcutLabel, type Shortcut } from '../../shortcuts'
import { Menu } from '../ui/menu'
import { MenuRows, type Item } from '../ui/MenuPanel'
import { renderClosingPositioner } from '../ui/closing-positioner'
import type { Target } from './DocContextMenu'

/** Puts the writing line's selection back and deletes it the way typing would, so React sees the input. */
function deleteInField(target: Target): void {
  const field = target.field
  if (!field?.element.isConnected) return
  field.element.focus()
  field.element.setSelectionRange(field.start, field.end)
  document.execCommand('delete')
}

const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined)

/**
 * The rows of Docs' right-click menu for `target`, at the pointer. The page is
 * read-only output, so rows that would change it are disabled, as Docs
 * disables rows that cannot apply: Copy works on a selection, and Cut and
 * Delete only in the writing line. Paste stays disabled because the window may
 * not read the clipboard (window.ts); Cmd+V still pastes. "Help me write" goes
 * to the writing line. Loaded on the first right click by DocContextMenu.
 */
export function DocContextPopup({
  target,
  open,
  onOpenChange,
}: {
  target: Target
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const os = platform()
  const keys = (shortcut: Shortcut) => shortcutLabel(shortcut, os)
  const hasText = Boolean(target.text)
  const editable = Boolean(target.field) && hasText

  const items: Item[] = [
    {
      id: 'cut',
      label: 'Cut',
      icon: 'content_cut',
      shortcut: keys({ key: 'x', mod: true }),
      disabled: !editable,
      run: () => {
        copy(target.text)
        deleteInField(target)
      },
    },
    {
      id: 'copy',
      label: 'Copy',
      icon: 'content_copy',
      shortcut: keys({ key: 'c', mod: true }),
      disabled: !hasText,
      run: () => copy(target.text),
    },
    { id: 'paste', label: 'Paste', icon: 'content_paste', shortcut: keys({ key: 'v', mod: true }), disabled: true },
    {
      id: 'paste-plain',
      label: 'Paste without formatting',
      icon: 'content_paste_go',
      shortcut: keys({ key: 'v', mod: true, shift: true }),
      disabled: true,
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: 'delete',
      disabled: !editable,
      run: () => deleteInField(target),
    },
    {
      id: 'help-me-write',
      label: 'Help me write',
      icon: 'edit_note',
      badge: 'New',
      divider: true,
      disabled: !target.composer?.isConnected,
      run: () => target.composer?.focus(),
    },
    {
      id: 'comment',
      label: 'Comment',
      icon: 'add_comment',
      shortcut: keys({ key: 'm', mod: true, alt: true }),
      divider: true,
      disabled: true,
    },
    { id: 'suggest', label: 'Suggest edits', icon: 'rate_review', disabled: true },
    { id: 'emoji', label: 'Insert emoji reaction', icon: 'mood', divider: true, disabled: true },
    { id: 'link', label: 'Insert link', icon: 'link', shortcut: keys({ key: 'k', mod: true }), disabled: true },
    {
      id: 'define',
      label: target.word ? `Define '${target.word}'` : 'Define',
      icon: 'dictionary',
      shortcut: keys({ key: 'y', mod: true, shift: true }),
      divider: true,
      disabled: true,
    },
    { id: 'format', label: 'Format options', icon: 'format_size', divider: true, disabled: true, submenu: [] },
    {
      id: 'clear',
      label: 'Clear formatting',
      icon: 'format_clear',
      shortcut: keys({ key: '\\', mod: true }),
      disabled: true,
    },
  ]

  // A zero-size box at the pointer, so the menu's top-left corner sits where the click was.
  const anchor = {
    getBoundingClientRect: () => DOMRect.fromRect({ x: target.x, y: target.y, width: 0, height: 0 }),
  }

  return (
    <Menu open={open} onOpenChange={onOpenChange} modal={false}>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          className="menu-positioner"
          render={renderClosingPositioner}
        >
          <MenuPrimitive.Popup className="menu-panel doc-context-menu" data-testid="doc-context-menu">
            <MenuRows items={items} itemPrefix="context" />
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </Menu>
  )
}
