/// <reference types="electron-vite/node" />
import { BrowserWindow, app, net, protocol, shell } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Snapshot } from '../codex/types'

let window: BrowserWindow | null = null

export function getWindow(): BrowserWindow | null {
  return window
}

export function resolvePreload(): string {
  const found = ['index.cjs', 'index.js', 'index.mjs']
    .map((name) => join(__dirname, '../preload', name))
    .find((file) => existsSync(file))
  return found ?? join(__dirname, '../preload/index.js')
}

export function createWindow(opts: { onDidFinishLoad: () => void }): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 560,
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
  win.webContents.on('did-finish-load', opts.onDidFinishLoad)
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('load failed', code, desc)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadURL('docs://app/index.html')
  }
  return win
}

export function registerDocsProtocol(): void {
  protocol.handle('docs', (request) => {
    const url = new URL(request.url)
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const root = join(__dirname, '../renderer')
    const file = normalize(join(root, pathname.replace(/^\/+/, '')))
    if (file !== root && !file.startsWith(root + sep)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).href)
  })
}

type ScreenshotSession = {
  subscribe: (listener: () => void) => () => void
  readonly snapshot: Snapshot
  openThread: (threadId: string) => Promise<void>
  newDocument: () => Promise<void>
}

export async function captureScreenshots(win: BrowserWindow, session: ScreenshotSession): Promise<void> {
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
