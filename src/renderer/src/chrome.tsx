import { useEffect, useRef, useState, type ReactNode } from 'react'

import { accountLabel, avatarLetter, displayServerName, toolsNeedingConnect } from '../../codex/labels'
import type { Snapshot } from '../../codex/types'
import { ChevronIcon } from './icons'
import { dispatch } from './session-bridge'

type MenuId = 'file' | 'edit' | 'view' | 'tools' | 'account' | 'model' | 'effort' | 'mode' | null

export function Banners({ snap }: { snap: Snapshot }) {
  return (
    <div className="banners">
      {snap.requiresAuth && snap.status === 'ready' && !snap.account ? (
        <div className="banner">
          <span data-testid="auth-banner">Sign in with ChatGPT to use Docs.</span>
          <button type="button" onClick={() => dispatch({ op: 'login' })}>
            Sign in
          </button>
        </div>
      ) : null}
      {snap.status === 'ready'
        ? toolsNeedingConnect(snap.mcpServers).map((server) => (
            <div className="banner warn" key={server.name}>
              <span data-testid={`mcp-banner-${server.name}`}>
                {displayServerName(server.name)} needs to be reconnected.
              </span>
              <button type="button" onClick={() => dispatch({ op: 'connectMcp', name: server.name })}>
                Connect
              </button>
            </div>
          ))
        : null}
      {snap.loginUrl && snap.status === 'ready' ? (
        <div className="banner">
          <span data-testid="login-url">Finish signing in in your browser.</span>
        </div>
      ) : null}
      {snap.error && snap.status === 'ready' ? (
        <div className="banner danger">
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
  return (
    <div className="avatar-wrap" ref={ref}>
      <button
        type="button"
        className="avatar"
        data-testid="menu-account"
        aria-label={accountLabel(snap.account)}
        onClick={() => setOpen((value) => !value)}
      >
        {avatarLetter(snap.account)}
      </button>
      {open ? (
        <div className="menu-panel" data-testid="panel-account" style={{ right: 0, left: 'auto' }}>
          {snap.account ? (
            <button
              type="button"
              className="menu-item"
              data-testid="action-logout"
              onClick={() => {
                dispatch({ op: 'logout' })
                setOpen(false)
              }}
            >
              Log out
            </button>
          ) : (
            <button
              type="button"
              className="menu-item"
              data-testid="action-login"
              onClick={() => {
                dispatch({ op: 'login' })
                setOpen(false)
              }}
            >
              Log in with ChatGPT
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}

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

  const fileItems = [
    { id: 'new', label: 'New document', run: () => dispatch({ op: 'newDocument' }) },
    { id: 'home', label: 'Open home', run: () => dispatch({ op: 'goHome' }) },
    { id: 'folder', label: 'Open folder…', run: () => dispatch({ op: 'openFolder' }) },
    { id: 'rename', label: 'Rename…', run: onRename, disabled: snap.route.kind !== 'doc' },
  ]
  const editItems = [
    { id: 'copy', label: 'Copy', run: () => document.execCommand('copy') },
    { id: 'paste', label: 'Paste', run: () => document.execCommand('paste') },
    { id: 'select', label: 'Select all', run: () => document.execCommand('selectAll') },
  ]
  const viewItems = [
    { id: 'grid', label: 'Grid view', run: onGrid },
    { id: 'list', label: 'List view', run: onList },
  ]
  const toolItems = [
    { id: 'refresh', label: 'Refresh from Codex', run: () => dispatch({ op: 'refresh' }) },
    ...snap.mcpServers
      .filter(
        (server) =>
          server.authStatus === 'notLoggedIn' ||
          server.runtimeStatus === 'authenticationRequired' ||
          server.runtimeStatus === 'failed',
      )
      .map((server) => ({
        id: `mcp-${server.name}`,
        label: `Connect ${displayServerName(server.name)}`,
        run: () => dispatch({ op: 'connectMcp', name: server.name }),
      })),
  ]

  return (
    <nav className="doc-menus" ref={ref}>
      <DropMenu id="file" label="File" menu={menu} setMenu={setMenu} items={fileItems} />
      <DropMenu id="edit" label="Edit" menu={menu} setMenu={setMenu} items={editItems} />
      <DropMenu id="view" label="View" menu={menu} setMenu={setMenu} items={viewItems} />
      <DropMenu id="tools" label="Tools" menu={menu} setMenu={setMenu} items={toolItems} />
    </nav>
  )
}

function DropMenu({
  id,
  label,
  menu,
  setMenu,
  items,
}: {
  id: Exclude<MenuId, null>
  label: string
  menu: MenuId
  setMenu: (id: MenuId) => void
  items: { id: string; label: string; run: () => void; disabled?: boolean }[]
}) {
  const open = menu === id
  return (
    <div className="menu">
      <button
        type="button"
        className={`menu-label${open ? ' open' : ''}`}
        data-testid={`menu-${id}`}
        onClick={() => setMenu(open ? null : id)}
      >
        {label}
      </button>
      {open ? (
        <div className="menu-panel" data-testid={`panel-${id}`}>
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              className="menu-item"
              data-testid={`action-${item.id}`}
              disabled={item.disabled}
              onClick={() => {
                item.run()
                setMenu(null)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function Toolbar({ snap }: { snap: Snapshot }) {
  const [menu, setMenu] = useState<MenuId>(null)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(Boolean(menu), () => setMenu(null), ref)
  const model = snap.models.find((item) => item.model === snap.model)
  const efforts = model?.supportedReasoningEfforts ?? []
  const used = snap.rateLimits?.rateLimits.primary
    ? `${Math.round(snap.rateLimits.rateLimits.primary.usedPercent)}%`
    : null

  return (
    <div className="toolbar" ref={ref}>
      <Chip
        testId="chip-model"
        label={model?.displayName ?? snap.model ?? 'Model'}
        open={menu === 'model'}
        onClick={() => setMenu(menu === 'model' ? null : 'model')}
      >
        {menu === 'model'
          ? snap.models.map((item) => (
              <button
                type="button"
                key={item.model}
                className="menu-item"
                data-testid={`pick-${item.model}`}
                onClick={() => {
                  dispatch({ op: 'setModel', model: item.model })
                  setMenu(null)
                }}
              >
                {item.displayName}
              </button>
            ))
          : null}
      </Chip>
      {efforts.length > 0 ? (
        <Chip
          testId="chip-effort"
          label={snap.effort ?? 'Effort'}
          open={menu === 'effort'}
          onClick={() => setMenu(menu === 'effort' ? null : 'effort')}
        >
          {menu === 'effort'
            ? efforts.map((item) => (
                <button
                  type="button"
                  key={item.reasoningEffort}
                  className="menu-item"
                  data-testid={`pick-${item.reasoningEffort}`}
                  onClick={() => {
                    dispatch({ op: 'setEffort', effort: item.reasoningEffort })
                    setMenu(null)
                  }}
                >
                  {item.reasoningEffort}
                </button>
              ))
            : null}
        </Chip>
      ) : null}
      {snap.collaborationModes.length > 0 ? (
        <Chip
          testId="chip-mode"
          label={snap.collaborationMode ?? 'Mode'}
          open={menu === 'mode'}
          onClick={() => setMenu(menu === 'mode' ? null : 'mode')}
        >
          {menu === 'mode'
            ? snap.collaborationModes.map((item) => (
                <button
                  type="button"
                  key={item.name}
                  className="menu-item"
                  data-testid={`pick-${item.name}`}
                  onClick={() => {
                    dispatch({ op: 'setCollaborationMode', name: item.name })
                    setMenu(null)
                  }}
                >
                  {item.name}
                </button>
              ))
            : null}
        </Chip>
      ) : null}
      <div className="toolbar-spacer" />
      {used ? <span className="rate">{used} used</span> : null}
    </div>
  )
}

function Chip({
  label,
  open,
  onClick,
  testId,
  children,
}: {
  label: string
  open: boolean
  onClick: () => void
  testId: string
  children?: ReactNode
}) {
  return (
    <div className="menu">
      <button type="button" className={`chip${open ? ' open' : ''}`} data-testid={testId} onClick={onClick}>
        {label}
        <ChevronIcon />
      </button>
      {open ? <div className="menu-panel">{children}</div> : null}
    </div>
  )
}

function useDismiss(active: boolean, onClose: () => void, ref: { current: HTMLElement | null }) {
  useEffect(() => {
    if (!active) return
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
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
