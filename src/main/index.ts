/// <reference types="electron-vite/node" />
import { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } from 'electron'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createFakeTransport } from '../codex/fake'
import { displayServerName, needsReconnect } from '../codex/labels'
import { CodexSession } from '../codex/session'
import { spawnCodexAppServer } from '../codex/transport'
import type { Command, MenuAction } from '../shared/api'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'docs',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

function prependPath() {
  if (process.platform !== 'darwin') return
  const home = process.env.HOME ?? ''
  const extras = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    home ? `${home}/.bun/bin` : '',
    home ? `${home}/.local/bin` : '',
  ].filter(Boolean)
  process.env.PATH = `${extras.join(':')}:${process.env.PATH ?? ''}`
}

prependPath()

const session = new CodexSession(
  process.env.HIDEGPT_FAKE === '1' ? () => createFakeTransport() : spawnCodexAppServer,
  (url) => {
    void shell.openExternal(url)
  },
)

let window: BrowserWindow | null = null
let menuSignature = ''

function sendSnapshot() {
  const snap = session.getSnapshot()
  const title = snap.route.kind === 'home' ? 'Docs' : snap.title || 'Docs'
  window?.setTitle(title)
  window?.webContents.send('snapshot', snap)
  const signature = JSON.stringify({
    account: snap.account,
    mcp: snap.mcpServers.map((server) => [server.name, server.authStatus, server.runtimeStatus]),
    route: snap.route.kind,
  })
  if (signature !== menuSignature) {
    menuSignature = signature
    rebuildMenu()
  }
}

async function runCommand(command: Command): Promise<void> {
  switch (command.op) {
    case 'newDocument':
      await session.newDocument()
      return
    case 'openThread':
      await session.openThread(command.threadId)
      return
    case 'goHome':
      session.goHome()
      return
    case 'send':
      await session.send(command.text)
      return
    case 'interrupt':
      await session.interrupt()
      return
    case 'login':
      await session.login()
      return
    case 'logout':
      await session.logout()
      return
    case 'connectMcp':
      await session.connectMcp(command.name)
      return
    case 'setSearch':
      session.setSearch(command.value)
      return
    case 'applySearch':
      await session.applySearch()
      return
    case 'setModel':
      session.setModel(command.model)
      return
    case 'setEffort':
      session.setEffort(command.effort)
      return
    case 'setCollaborationMode':
      session.setCollaborationMode(command.name)
      return
    case 'openFolder':
      await pickFolder()
      return
    case 'loadOlderTurns':
      await session.loadOlderTurns()
      return
    case 'resolveApproval':
      session.resolveApproval(command.blockId, command.accept)
      return
    case 'setApprovalDraft':
      session.setApprovalDraft(command.blockId, command.key, command.value)
      return
    case 'setDocumentName':
      await session.setDocumentName(command.name)
      return
    case 'refresh':
      if (session.snapshot.status === 'error') await session.start()
      else await session.refreshCatalog()
      return
  }
}

async function pickFolder() {
  if (!window) return
  const result = await dialog.showOpenDialog(window, {
    title: 'Open folder',
    properties: ['openDirectory'],
    defaultPath: session.snapshot.cwd || undefined,
  })
  if (result.canceled || !result.filePaths[0]) return
  session.setFolderDraft(result.filePaths[0])
  session.applyFolder()
}

function sendMenu(action: MenuAction) {
  window?.webContents.send('menu', action)
}

function rebuildMenu() {
  const snap = session.getSnapshot()
  const isMac = process.platform === 'darwin'
  const connectItems = snap.mcpServers.filter(needsReconnect).map((server) => ({
    label: `Connect ${displayServerName(server.name)}`,
    click: () => void session.connectMcp(server.name),
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
          click: () => void session.newDocument(),
        },
        {
          label: 'Open home',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => session.goHome(),
        },
        {
          label: 'Open folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void pickFolder(),
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
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Grid view', click: () => sendMenu('grid') },
        { label: 'List view', click: () => sendMenu('list') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Refresh from Codex',
          click: () => void runCommand({ op: 'refresh' }),
        },
        ...connectItems,
      ],
    },
    {
      label: 'Account',
      submenu: snap.account
        ? [{ label: 'Log out', click: () => void session.logout() }]
        : [{ label: 'Log in with ChatGPT', click: () => void session.login() }],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function resolvePreload() {
  for (const name of ['index.cjs', 'index.js', 'index.mjs']) {
    const file = join(__dirname, '../preload', name)
    if (existsSync(file)) return file
  }
  return join(__dirname, '../preload/index.js')
}

function createWindow() {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 640,
    title: 'Docs',
    backgroundColor: '#ffffff',
    show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 22 } : undefined,
    webPreferences: {
      preload: resolvePreload(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window = win
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (window === win) window = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadURL('docs://app/index.html')
  }
  return win
}

async function captureScreenshots(win: BrowserWindow) {
  const dir = process.env.HIDEGPT_SCREENSHOT
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) {
      resolve()
      return
    }
    win.webContents.once('did-finish-load', () => resolve())
  })
  await new Promise<void>((resolve) => {
    const stop = session.subscribe(() => {
      if (session.snapshot.status !== 'connecting') {
        stop()
        resolve()
      }
    })
    if (session.snapshot.status !== 'connecting') {
      stop()
      resolve()
    }
  })
  win.show()
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        if (document.querySelector('[data-testid="app"]')) resolve(true)
        else if (Date.now() - started > 8000) reject(new Error('renderer did not mount'))
        else setTimeout(tick, 50)
      }
      tick()
    })
  `)
  await new Promise((resolve) => setTimeout(resolve, 200))
  writeFileSync(join(dir, 'home.png'), (await win.capturePage()).toPNG())
  const first = session.snapshot.threads[0]
  if (first) await session.openThread(first.id)
  else await session.newDocument()
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        if (document.querySelector('[data-testid="document"]')) resolve(true)
        else if (Date.now() - started > 8000) reject(new Error('document did not mount'))
        else setTimeout(tick, 50)
      }
      tick()
    })
  `)
  await new Promise((resolve) => setTimeout(resolve, 200))
  writeFileSync(join(dir, 'document.png'), (await win.capturePage()).toPNG())
  app.quit()
}

app.setName('Docs')

function registerDocsProtocol() {
  protocol.handle('docs', (request) => {
    const url = new URL(request.url)
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const root = join(__dirname, '../renderer')
    const file = normalize(join(root, pathname.replace(/^\/+/, '')))
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).href)
  })
}

app.whenReady().then(async () => {
  registerDocsProtocol()
  ipcMain.handle('command', async (_event, command: Command) => {
    await runCommand(command)
  })
  session.subscribe(sendSnapshot)
  rebuildMenu()
  const win = createWindow()
  win.webContents.on('did-finish-load', sendSnapshot)
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('load failed', code, desc)
  })
  try {
    await session.start()
    await captureScreenshots(win)
  } catch (error) {
    console.error(error)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('before-quit', () => {
  void session.close()
})
