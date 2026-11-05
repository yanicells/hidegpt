/// <reference types="electron-vite/node" />
import { BrowserWindow, app, net, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

let window: BrowserWindow | null = null

export function getWindow(): BrowserWindow | null {
  return window
}

// Main is ESM and its chunks sit together in out/main. electron-vite's
// __dirname shim is not reliable once dependencies are bundled in, so this
// reads the folder directly.
const here = import.meta.dirname

export function resolvePreload(): string {
  const found = ['index.cjs', 'index.js', 'index.mjs']
    .map((name) => join(here, '../preload', name))
    .find((file) => existsSync(file))
  return found ?? join(here, '../preload/index.js')
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
  const appUrl = process.env.ELECTRON_RENDERER_URL ?? APP_URL
  // Links in answers open in the browser; the window itself never leaves the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppNavigation(appUrl, url)) return
    event.preventDefault()
    openExternal(url)
  })
  win.webContents.on('did-finish-load', opts.onDidFinishLoad)
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('load failed', code, desc)
  })

  void win.loadURL(appUrl)
  return win
}

const APP_URL = 'docs://app/index.html'
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

// `isAppNavigation` and `safeExternalUrl` are adapted from T3 Code
// (apps/desktop/src/window/DesktopWindow.ts `isSameOriginRendererNavigation`,
// apps/desktop/src/electron/ElectronShell.ts `parseSafeExternalUrl`) at commit
// 8a14762c. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

/** Same scheme and host as the app (a reload, or the dev server's HMR). */
export function isAppNavigation(appUrl: string, url: string): boolean {
  try {
    const app = new URL(appUrl)
    const next = new URL(url)
    // Node serializes custom-scheme origins as "null", so compare scheme and host instead.
    return app.host !== '' && next.protocol === app.protocol && next.host === app.host
  } catch {
    return false
  }
}

/** Only web and mail links leave the app; `file:`, `javascript:` and custom schemes do not. */
export function safeExternalUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

export function openExternal(raw: string): void {
  const url = safeExternalUrl(raw)
  if (url) void shell.openExternal(url).catch(() => undefined)
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}
const IMAGE_FILES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** Pasted images live beside app data so documents can show them after restarts. */
export async function saveImage(bytes: Uint8Array, mime: string): Promise<string> {
  const ext = IMAGE_EXTENSIONS[mime]
  if (!ext) throw new Error('Only PNG, JPEG, GIF, and WebP images can be inserted.')
  const dir = join(app.getPath('userData'), 'images')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${randomUUID()}${ext}`)
  await writeFile(file, bytes)
  return file
}

/**
 * `docs://app/...` serves the renderer bundle; `docs://local/<encoded path>`
 * serves local images (pasted images, images in thread history) to <img>.
 */
export function registerDocsProtocol(): void {
  protocol.handle('docs', (request) => {
    const url = new URL(request.url)
    if (url.host === 'local') {
      const file = decodeURIComponent(url.pathname.slice(1))
      if (!IMAGE_FILES.has(extname(file).toLowerCase())) return new Response('forbidden', { status: 403 })
      return net.fetch(pathToFileURL(file).href)
    }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const root = join(here, '../renderer')
    const file = normalize(join(root, pathname.replace(/^\/+/, '')))
    if (file !== root && !file.startsWith(root + sep)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).href)
  })
}
