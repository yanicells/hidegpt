import { app, Menu } from 'electron'
import type { BrowserWindow } from 'electron'

import { displayServerName, needsReconnect, PROVIDERS, providerLabel } from '../codex/labels'
import type { Snapshot } from '../codex/types'
import type { Command, MenuAction } from '../shared/api'

type MenuDeps = {
  getSnapshot: () => Snapshot
  dispatch: (command: Command) => void | Promise<void>
  getWindow: () => BrowserWindow | null
}

let deps: MenuDeps = {
  getSnapshot: () => {
    throw new Error('menu not initialized')
  },
  dispatch: () => {},
  getWindow: () => null,
}

/** Wire snapshot/dispatch collaborators instead of importing sessions. */
export function initMenu(next: MenuDeps): void {
  deps = next
}

export function sendMenu(action: MenuAction): void {
  deps.getWindow()?.webContents.send('menu', action)
}

function signatureFor(snap: Snapshot): string {
  const account = !snap.account
    ? 'none'
    : snap.account.type === 'chatgpt'
      ? `chatgpt:${snap.account.email ?? ''}`
      : snap.account.type
  const mcp = snap.mcpServers.map((server) => `${server.name}:${server.authStatus}:${server.runtimeStatus}`).join(',')
  const route = snap.route.kind === 'doc' ? `doc:${snap.route.threadId}` : 'home'
  return `${snap.provider}|${account}|${mcp}|${route}`
}

let menuSignature = ''

export function updateMenuForSnapshot(snap: Snapshot): void {
  const signature = signatureFor(snap)
  if (signature !== menuSignature) {
    menuSignature = signature
    rebuildMenu()
  }
}

export function rebuildMenu(): void {
  const snap = deps.getSnapshot()
  const isMac = process.platform === 'darwin'
  const connectItems = snap.mcpServers.filter(needsReconnect).map((server) => ({
    label: `Connect ${displayServerName(server.name)}`,
    click: () => void deps.dispatch({ op: 'connectMcp', name: server.name }),
  }))

  const template: Electron.MenuItemConstructorOptions[] = [
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
        {
          label: 'New document',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenu('newDocument'),
        },
        {
          label: 'Open home',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => void deps.dispatch({ op: 'goHome' }),
        },
        {
          label: 'Open folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void deps.dispatch({ op: 'openFolder' }),
        },
        { type: 'separator' },
        {
          label: 'Rename…',
          accelerator: 'CmdOrCtrl+Shift+R',
          enabled: snap.route.kind === 'doc',
          click: () => sendMenu('rename'),
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
            if (deps.getSnapshot().route.kind !== 'home') void deps.dispatch({ op: 'goHome' })
            sendMenu('focusSearch')
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Grid view', click: () => sendMenu('grid') },
        { label: 'List view', click: () => sendMenu('list') },
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
      submenu: [
        ...PROVIDERS.map((provider) => ({
          label: `Use ${providerLabel(provider)}`,
          type: 'checkbox' as const,
          checked: snap.provider === provider,
          click: () => void deps.dispatch({ op: 'setProvider', provider }),
        })),
        { type: 'separator' },
        {
          label: 'Refresh',
          click: () => void deps.dispatch({ op: 'refresh' }),
        },
        ...connectItems,
      ],
    },
    {
      label: 'Account',
      submenu: snap.account
        ? [{ label: 'Log out', click: () => void deps.dispatch({ op: 'logout' }) }]
        : [{ label: 'Log in with ChatGPT', click: () => void deps.dispatch({ op: 'login' }) }],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
