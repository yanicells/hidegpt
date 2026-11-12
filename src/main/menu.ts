import { app, Menu } from 'electron'

import type { Command, MenuAction, Snapshot } from '../shared/contracts'

/**
 * The application menu, rebuilt only when something it shows changes. Menu
 * commands go through the same `dispatch` as the window's; renderer-only
 * actions (rename, view mode, find) are sent to the window as `MenuAction`s.
 */
export type MenuHandlers = {
  readonly dispatch: (command: Command) => void
  readonly send: (action: MenuAction) => void
  /** Help → Report a problem…: shows the folder of saved reports. */
  readonly reportProblem: () => void
}

export function makeMenu(handlers: MenuHandlers): (snap: Snapshot) => void {
  let shown = ''
  return (snap) => {
    // The page (Home or a document) is the only thing the menu depends on.
    const next = snap.route.kind
    if (next === shown) return
    shown = next
    Menu.setApplicationMenu(Menu.buildFromTemplate(template(snap, handlers)))
  }
}

/**
 * The menu for `snap`, trimmed to what an installed Docs app window shows:
 * Docs, File, Edit, View, History, Window, Help. Accounts and connections live
 * in the page (the account menu and Extensions), as they do in Docs.
 * Exported for tests.
 */
export function template(snap: Snapshot, handlers: MenuHandlers): Electron.MenuItemConstructorOptions[] {
  const { dispatch, send } = handlers
  const isMac = process.platform === 'darwin'
  const inDoc = snap.route.kind === 'doc'
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
        { label: 'Rename…', accelerator: 'CmdOrCtrl+Shift+R', enabled: inDoc, click: () => send('rename') },
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
        // A document searches itself; Home searches the documents.
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send(inDoc ? 'find' : 'focusSearch') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Grid view', click: () => send('grid') },
        { label: 'List view', click: () => send('list') },
        { type: 'separator' },
        { label: 'Reload this page', accelerator: 'CmdOrCtrl+R', click: () => dispatch({ op: 'refresh' }) },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Development keeps a renderer reload, off Cmd+R, which reloads the page's data above.
        ...(app.isPackaged
          ? []
          : [{ type: 'separator' as const }, { role: 'forceReload' as const }, { role: 'toggleDevTools' as const }]),
      ],
    },
    {
      label: 'History',
      submenu: [{ label: 'Back', accelerator: 'CmdOrCtrl+[', enabled: inDoc, click: () => dispatch({ op: 'goHome' }) }],
    },
    {
      // Spelled out rather than `windowMenu`, whose macOS default adds a second Cmd+W next to File's.
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }],
    },
    { role: 'help', submenu: [{ label: 'Report a problem…', click: handlers.reportProblem }] },
  ]
}
