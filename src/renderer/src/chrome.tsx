import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import { accountLabel, avatarLetter, displayServerName, toolsNeedingConnect } from '../../codex/labels'
import type { Snapshot } from '../../codex/types'
import { ChevronIcon, PenIcon } from './icons'
import { dispatch } from './session-bridge'

type MenuId = 'file' | 'edit' | 'view' | 'tools' | 'account' | 'model' | 'effort' | 'mode' | 'provider' | null

type Item = { id: string; label: string; run: () => void; disabled?: boolean; checked?: boolean }

export function Banners({ snap }: { snap: Snapshot }) {
  if (snap.status !== 'ready') return null
  // Connection and tool-auth state lives under Tools, never on the page.
  // Only sign-in, explicit follow-ups, and real errors surface here.
  return (
    <div className="banners">
      {snap.requiresAuth && !snap.account ? (
        <div className="banner" role="status">
          <span data-testid="auth-banner">Sign in to use Docs.</span>
          <button type="button" onClick={() => dispatch({ op: 'login' })}>
            Sign in
          </button>
        </div>
      ) : null}
      {snap.loginUrl ? (
        <div className="banner" role="status">
          <span data-testid="login-url">Finish signing in in your browser.</span>
        </div>
      ) : null}
      {snap.error ? (
        <div className="banner danger" role="alert">
          <span data-testid="error-banner">{snap.error}</span>
        </div>
      ) : null}
    </div>
  )
}

export function AccountMenu({ snap }: { snap: Snapshot }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  // OpenCode auth lives in the terminal (`opencode auth`); the account menu
  // only manages the ChatGPT login behind the Codex provider.
  const items: Item[] =
    snap.provider === 'opencode'
      ? []
      : snap.account
        ? [{ id: 'logout', label: 'Log out', run: () => dispatch({ op: 'logout' }) }]
        : [{ id: 'login', label: 'Log in with ChatGPT', run: () => dispatch({ op: 'login' }) }]
  const caption = snap.provider === 'opencode' ? 'OpenCode session' : null
  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="avatar"
        data-testid="menu-account"
        aria-label={accountLabel(snap.account)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={accountLabel(snap.account)}
        onClick={() => setOpen((value) => !value)}
      >
        {avatarLetter(snap.account)}
      </button>
      {open ? (
        <MenuPanel testId="panel-account" align="end" items={items} onClose={() => setOpen(false)}>
          {caption ? (
            <div className="menu-caption">{caption}</div>
          ) : snap.account ? (
            <div className="menu-caption">{accountLabel(snap.account)}</div>
          ) : null}
        </MenuPanel>
      ) : null}
    </div>
  )
}

const MENU_ORDER = ['file', 'edit', 'view', 'tools'] as const

export function DocMenus({
  snap,
  onRename,
  onGrid,
  onList,
}: {
  snap: Snapshot
  onRename: () => void
  onGrid: () => void
  onList: () => void
}) {
  const [menu, setMenu] = useState<MenuId>(null)
  const ref = useRef<HTMLElement>(null)
  useDismiss(Boolean(menu), () => setMenu(null), ref)

  const items: Record<(typeof MENU_ORDER)[number], Item[]> = {
    file: [
      { id: 'new', label: 'New document', run: () => dispatch({ op: 'newDocument' }) },
      { id: 'home', label: 'Open home', run: () => dispatch({ op: 'goHome' }) },
      { id: 'folder', label: 'Open folder…', run: () => dispatch({ op: 'openFolder' }) },
      { id: 'rename', label: 'Rename…', run: onRename, disabled: snap.route.kind !== 'doc' },
    ],
    edit: [
      { id: 'copy', label: 'Copy', run: () => document.execCommand('copy') },
      { id: 'paste', label: 'Paste', run: () => document.execCommand('paste') },
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

export function Toolbar({ snap }: { snap: Snapshot }) {
  const [menu, setMenu] = useState<MenuId>(null)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(Boolean(menu), () => setMenu(null), ref)
  const model = snap.models.find((item) => item.model === snap.model)
  const efforts = model?.supportedReasoningEfforts ?? []
  const toggle = (id: MenuId) => setMenu(menu === id ? null : id)

  return (
    <div className="toolbar-wrap">
      <div className="toolbar" ref={ref} role="toolbar" aria-label="Document settings">
        <Chip
          testId="chip-model"
          label={model?.displayName ?? snap.model ?? 'Model'}
          open={menu === 'model'}
          onClick={() => toggle('model')}
          items={snap.models.map((item) => ({
            id: item.model,
            label: item.displayName,
            checked: item.model === snap.model,
            run: () => dispatch({ op: 'setModel', model: item.model }),
          }))}
          onClose={() => setMenu(null)}
        />
        {efforts.length > 0 ? (
          <>
            <span className="divider" aria-hidden="true" />
            <Chip
              testId="chip-effort"
              label={capitalize(snap.effort ?? 'Effort')}
              open={menu === 'effort'}
              onClick={() => toggle('effort')}
              items={efforts.map((item) => ({
                id: item.reasoningEffort,
                label: capitalize(item.reasoningEffort),
                checked: item.reasoningEffort === snap.effort,
                run: () => dispatch({ op: 'setEffort', effort: item.reasoningEffort }),
              }))}
              onClose={() => setMenu(null)}
            />
          </>
        ) : null}
        <div className="toolbar-spacer" />
        <Chip
          testId="chip-provider"
          label={snap.provider === 'codex' ? 'Codex' : 'OpenCode'}
          open={menu === 'provider'}
          align="end"
          onClick={() => toggle('provider')}
          items={[
            {
              id: 'codex',
              label: 'Codex',
              checked: snap.provider === 'codex',
              run: () => dispatch({ op: 'setProvider', provider: 'codex' }),
            },
            {
              id: 'opencode',
              label: 'OpenCode',
              checked: snap.provider === 'opencode',
              run: () => dispatch({ op: 'setProvider', provider: 'opencode' }),
            },
          ]}
          onClose={() => setMenu(null)}
        />
        {snap.collaborationModes.length > 0 ? (
          <>
            <span className="divider" aria-hidden="true" />
            <Chip
              testId="chip-mode"
              icon={<PenIcon />}
              label={snap.collaborationMode ?? 'Mode'}
              open={menu === 'mode'}
              align="end"
              onClick={() => toggle('mode')}
              items={snap.collaborationModes.map((item) => ({
                id: item.name,
                label: item.name,
                checked: item.name === snap.collaborationMode,
                run: () => dispatch({ op: 'setCollaborationMode', name: item.name }),
              }))}
              onClose={() => setMenu(null)}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}

function Chip({
  label,
  icon,
  open,
  onClick,
  testId,
  items,
  align,
  onClose,
}: {
  label: string
  icon?: ReactNode
  open: boolean
  onClick: () => void
  testId: string
  items: Item[]
  align?: 'start' | 'end'
  onClose: () => void
}) {
  return (
    <div className="menu">
      <button
        type="button"
        className={`chip${open ? ' open' : ''}`}
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onClick}
      >
        {icon}
        <span className="chip-label">{label}</span>
        <ChevronIcon />
      </button>
      {open ? <MenuPanel items={items} align={align} onClose={onClose} itemPrefix="pick" /> : null}
    </div>
  )
}

function MenuPanel({
  items,
  onClose,
  testId,
  align = 'start',
  itemPrefix = 'action',
  children,
}: {
  items: Item[]
  onClose: () => void
  testId?: string
  align?: 'start' | 'end'
  itemPrefix?: string
  children?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [],
    )
    if (buttons.length === 0) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  return (
    <div
      ref={ref}
      className={`menu-panel align-${align}`}
      role="menu"
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {children}
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          className={`menu-item${item.checked ? ' checked' : ''}`}
          role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.checked}
          data-testid={`${itemPrefix}-${item.id}`}
          disabled={item.disabled}
          onClick={() => {
            item.run()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

function useDismiss(active: boolean, onClose: () => void, ref: { current: HTMLElement | null }) {
  useEffect(() => {
    if (!active) return
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [active, onClose, ref])
}
