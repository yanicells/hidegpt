import { app, Menu } from 'electron'

import type { Command, MenuAction, Route, Snapshot } from '../shared/contracts'

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
    const page = snap.route.kind
    if (page === shown) return
    shown = page
    Menu.setApplicationMenu(Menu.buildFromTemplate(template(page, handlers)))
  }
}

/**
 * The menu for `page` (Home or a document), trimmed to what an installed Docs app window shows:
 * Docs, File, Edit, View, History, Window, Help. Accounts and connections live
 * in the page (the account menu and Extensions), as they do in Docs.
 * Exported for tests.
 */
export function template(page: Route['kind'], handlers: MenuHandlers): Electron.MenuItemConstructorOptions[] {
  const { dispatch, send } = handlers
  const isMac = process.platform === 'darwin'
  const inDoc = page === 'doc'
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
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut' },
        ...hiddenZoomItems(isMac),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Development keeps a renderer reload on Alt+Cmd+R: Cmd+R reloads the page's
        // data above, and forceReload's default Shift+Cmd+R is File → Rename….
        ...(app.isPackaged
          ? []
          : [
              { type: 'separator' as const },
              { role: 'forceReload' as const, accelerator: 'Alt+CmdOrCtrl+R' },
              { role: 'toggleDevTools' as const },
            ]),
      ],
    },
    {
      label: 'History',
      // No shortcut: menu shortcuts fire before the page sees the key, and in Docs
      // Cmd+[ decreases indent, so binding it here would leave the document (and its
      // unsent draft) on one keystroke.
      submenu: [{ label: 'Back', enabled: inDoc, click: () => dispatch({ op: 'goHome' }) }],
    },
    {
      // The role marks this as the Window menu, so macOS adds the open windows and
      // Move & Resize. The submenu replaces Electron's default, which adds a Ctrl+W
      // close role off macOS (as in T3 Code's DesktopApplicationMenu.ts).
      role: 'windowMenu',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }],
    },
    { role: 'help', submenu: [{ label: 'Report a problem…', click: handlers.reportProblem }] },
  ]
}

// `hiddenZoomItems` is adapted from T3 Code (apps/desktop/src/window/DesktopApplicationMenu.ts,
// the View menu's hidden zoom items) at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License.
/**
 * Other keys for the zoom items above, as hidden items so the menu shows one
 * of each. `zoomIn`'s default, Cmd+Plus, needs Shift on most keyboards, so
 * the visible item takes Cmd+= and these keep Cmd+Plus, Shift+Cmd+= (macOS)
 * and the keypad, whose keys don't match number-row shortcuts.
 */
function hiddenZoomItems(isMac: boolean): Electron.MenuItemConstructorOptions[] {
  return [
    { role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus', visible: false },
    ...(isMac ? [{ role: 'zoomIn' as const, accelerator: 'CmdOrCtrl+Shift+=', visible: false }] : []),
    { role: 'resetZoom', accelerator: 'CmdOrCtrl+num0', visible: false },
    { role: 'zoomIn', accelerator: 'CmdOrCtrl+numadd', visible: false },
    { role: 'zoomOut', accelerator: 'CmdOrCtrl+numsub', visible: false },
  ]
}
