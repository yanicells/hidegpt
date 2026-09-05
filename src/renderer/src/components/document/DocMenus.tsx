import { useRef, useState, type KeyboardEvent } from 'react'

import { displayServerName, toolsNeedingConnect } from '../../../../codex/labels'
import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { MenuPanel, useDismiss, type Item, type MenuId } from '../ui/MenuPanel'

const MENU_ORDER = ['file', 'edit', 'view', 'tools'] as const

export function DocMenus({
  snap,
  onNew,
  onRename,
  onGrid,
  onList,
}: {
  snap: Snapshot
  onNew: () => void
  onRename: () => void
  onGrid: () => void
  onList: () => void
}) {
  const [menu, setMenu] = useState<MenuId>(null)
  const ref = useRef<HTMLElement>(null)
  useDismiss(Boolean(menu), () => setMenu(null), ref)

  const items: Record<(typeof MENU_ORDER)[number], Item[]> = {
    file: [
      { id: 'new', label: 'New document', run: onNew },
      { id: 'home', label: 'Open home', run: () => dispatch({ op: 'goHome' }) },
      { id: 'folder', label: 'Open folder…', run: () => dispatch({ op: 'openFolder' }) },
      { id: 'rename', label: 'Rename…', run: onRename, disabled: snap.route.kind !== 'doc' },
    ],
    edit: [
      { id: 'copy', label: 'Copy', run: () => document.execCommand('copy') },
      { id: 'select', label: 'Select all', run: () => document.execCommand('selectAll') },
    ],
    view: [
      { id: 'grid', label: 'Grid view', run: onGrid },
      { id: 'list', label: 'List view', run: onList },
    ],
    tools: [
      { id: 'refresh', label: 'Refresh', run: () => dispatch({ op: 'refresh' }) },
      {
        id: 'provider-codex',
        label: 'Use Codex',
        checked: snap.provider === 'codex',
        run: () => dispatch({ op: 'setProvider', provider: 'codex' }),
      },
      {
        id: 'provider-opencode',
        label: 'Use OpenCode',
        checked: snap.provider === 'opencode',
        run: () => dispatch({ op: 'setProvider', provider: 'opencode' }),
      },
      ...toolsNeedingConnect(snap.mcpServers).map((server) => ({
        id: `mcp-${server.name}`,
        label: `Connect ${displayServerName(server.name)}`,
        run: () => dispatch({ op: 'connectMcp', name: server.name }),
      })),
    ],
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!menu || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    const index = MENU_ORDER.indexOf(menu as (typeof MENU_ORDER)[number])
    if (index < 0) return
    event.preventDefault()
    const step = event.key === 'ArrowRight' ? 1 : -1
    setMenu(MENU_ORDER[(index + step + MENU_ORDER.length) % MENU_ORDER.length])
  }

  return (
    <nav className="doc-menus" ref={ref} role="menubar" aria-label="Document" onKeyDown={onKeyDown}>
      {MENU_ORDER.map((id) => (
        <div className="menu" key={id}>
          <button
            type="button"
            className={`menu-label${menu === id ? ' open' : ''}`}
            data-testid={`menu-${id}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={menu === id}
            onClick={() => setMenu(menu === id ? null : id)}
            onMouseEnter={() => {
              if (menu && menu !== id) setMenu(id)
            }}
          >
            {id.charAt(0).toUpperCase() + id.slice(1)}
          </button>
          {menu === id ? <MenuPanel testId={`panel-${id}`} items={items[id]} onClose={() => setMenu(null)} /> : null}
        </div>
      ))}
    </nav>
  )
}
