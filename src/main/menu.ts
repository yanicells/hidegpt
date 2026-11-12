import { app, Menu } from 'electron'

import type { Command, MenuAction, Snapshot } from '../shared/contracts'
import { accountLabel, displayServerName, libraryName, PROVIDERS, toolsNeedingConnect } from '../shared/labels'

/**
 * The application menu, rebuilt only when something it shows changes. Menu
 * commands go through the same `dispatch` as the window's; renderer-only
 * actions (rename, view mode) are sent to the window as `MenuAction`s.
 */
export type MenuHandlers = {
  readonly dispatch: (command: Command) => void
  readonly send: (action: MenuAction) => void
  /** Help → Report a problem…: shows the folder of saved reports. */
  readonly reportProblem: () => void
}

const signature = (snap: Snapshot) =>
  [
    snap.provider,
    snap.capabilities.login,
    snap.account ? `${snap.account.kind}:${snap.account.label}` : 'none',
    toolsNeedingConnect(snap.mcpServers)
      .map((server) => server.name)
      .join(','),
    snap.route.kind,
  ].join('|')

export function makeMenu(handlers: MenuHandlers): (snap: Snapshot) => void {
  let shown = ''
  return (snap) => {
    const next = signature(snap)
    if (next === shown) return
    shown = next
    Menu.setApplicationMenu(Menu.buildFromTemplate(template(snap, handlers)))
  }
}

/** Google's wording: the account, then switching between the person's accounts (libraries). */
function accountItems(snap: Snapshot, { dispatch }: MenuHandlers): Electron.MenuItemConstructorOptions[] {
  // Libraries that don't sign in from Docs reuse their CLI's login, so they only show the account.
  const signIn: Electron.MenuItemConstructorOptions[] = !snap.capabilities.login
    ? []
    : snap.account
      ? [{ label: 'Sign out', click: () => dispatch({ op: 'logout' }) }]
      : [{ label: 'Sign in', click: () => dispatch({ op: 'login' }) }]
  return [
    { label: snap.account ? accountLabel(snap.account) : 'Not signed in', enabled: false },
    ...signIn,
    { type: 'separator' },
    ...PROVIDERS.map((provider) => ({
      label: libraryName(provider),
      type: 'checkbox' as const,
      checked: snap.provider === provider,
      click: () => dispatch({ op: 'setProvider', provider }),
    })),
  ]
}

/** The menu for `snap`. Exported for tests. */
export function template(snap: Snapshot, handlers: MenuHandlers): Electron.MenuItemConstructorOptions[] {
  const { dispatch, send } = handlers
  const isMac = process.platform === 'darwin'
  const connectItems = toolsNeedingConnect(snap.mcpServers).map((server) => ({
    label: `Connect ${displayServerName(server.name)}`,
    click: () => dispatch({ op: 'connectMcp', name: server.name }),
  }))
  return [
    ...(isMac
      ? [
          {
            label: 'Docs',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New document', accelerator: 'CmdOrCtrl+N', click: () => send('newDocument') },
        { label: 'Open home', accelerator: 'CmdOrCtrl+Shift+O', click: () => dispatch({ op: 'goHome' }) },
        { label: 'Open folder…', accelerator: 'CmdOrCtrl+O', click: () => dispatch({ op: 'openFolder' }) },
        { type: 'separator' },
        {
          label: 'Rename…',
          accelerator: 'CmdOrCtrl+Shift+R',
          enabled: snap.route.kind === 'doc',
          click: () => send('rename'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find…',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            if (snap.route.kind !== 'home') dispatch({ op: 'goHome' })
            send('focusSearch')
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Grid view', click: () => send('grid') },
        { label: 'List view', click: () => send('list') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged
          ? []
          : [{ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const }]),
      ],
    },
    {
      label: 'Tools',
      submenu: [{ label: 'Refresh', click: () => dispatch({ op: 'refresh' }) }, ...connectItems],
    },
    { label: 'Account', submenu: accountItems(snap, handlers) },
    { role: 'help', submenu: [{ label: 'Report a problem…', click: handlers.reportProblem }] },
  ]
}
