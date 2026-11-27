/// <reference types="electron-vite/node" />
import { BrowserWindow, app, net, protocol, screen, shell, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Snapshot } from '../shared/model'
import { SCREENSHOT_SIZE } from './screenshots'

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

/**
 * Initial window bounds: fill the display's work area (menu bar and Dock
 * excluded), like a maximized Docs tab. Screenshot runs keep a fixed
 * 1280x840 so captures and benchmarks stay comparable across machines.
 */
function initialBounds(): { width: number; height: number; x?: number; y?: number } {
  if (process.env.HIDEGPT_SCREENSHOT) return { ...SCREENSHOT_SIZE }
  return screen.getPrimaryDisplay().workArea
}

export function createWindow(opts: { onDidFinishLoad: () => void }): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    ...initialBounds(),
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
  // A hidden fidelity capture never shows its window (src/main/fidelity/boot.ts).
  if (process.env.HIDEGPT_HIDDEN !== '1') win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (window === win) window = null
  })
  const appUrl = process.env.ELECTRON_RENDERER_URL ?? APP_URL
  wireNavigation(win, appUrl, opts.onDidFinishLoad)
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('load failed', code, desc)
  })
  denyPermissions(win.webContents.session)
  recoverRenderer(win, appUrl)

  loadApp(win, appUrl)
  return win
}

const APP_URL = 'docs://app/index.html'

/** The crash page is the only `data:` page a window ever shows. */
const isCrashPage = (url: string) => url.startsWith('data:')

/**
 * Keeps the window on the app. Links in answers open in the browser. The
 * crash page's "Try again" is cancelled and done from main, as T3 Code's
 * startup recovery window does (apps/desktop/src/app/DesktopStartupRecovery.ts),
 * and only the app's own loads resync the snapshot.
 */
export function wireNavigation(win: BrowserWindow, appUrl: string, onAppLoad: () => void): void {
  const { webContents } = win
  webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    if (isCrashPage(webContents.getURL())) {
      event.preventDefault()
      if (isAppNavigation(appUrl, url)) loadApp(win, appUrl)
      return
    }
    if (isAppNavigation(appUrl, url)) return
    event.preventDefault()
    openExternal(url)
  })
  webContents.on('did-finish-load', () => {
    if (!isCrashPage(webContents.getURL())) onAppLoad()
  })
}

/** Loads `url` unless the window is gone; a failed load is logged, as in T3's DesktopWindow. */
function loadApp(win: BrowserWindow, url: string): void {
  if (!win.isDestroyed()) win.loadURL(url).catch((error: unknown) => console.warn('window reload failed', error))
}
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

// `recoverRenderer` is adapted from T3 Code (apps/desktop/src/window/DesktopWindow.ts,
// the `render-process-gone` handler) at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License.
const RECOVERABLE_REASONS = new Set(['crashed', 'oom', 'killed', 'abnormal-exit'])
const RECOVERY_MAX_RELOADS = 3
const RECOVERY_WINDOW_MS = 60_000
const RECOVERY_RELOAD_DELAY_MS = 500
/** A renderer hung this long is killed, which the crash path then reloads. */
const UNRESPONSIVE_KILL_MS = 15_000

/**
 * Reloads a crashed or killed renderer, at most RECOVERY_MAX_RELOADS times a
 * minute per window, so a crash loop stops instead of spinning. A renderer
 * that stays unresponsive is killed and comes back the same way. The reload's
 * did-finish-load resyncs the snapshot, so the page returns as it was.
 */
export function recoverRenderer(win: BrowserWindow, appUrl: string, now: () => number = Date.now): void {
  let reloads: number[] = []
  let hung: ReturnType<typeof setTimeout> | undefined
  const settle = () => {
    clearTimeout(hung)
    hung = undefined
  }
  win.webContents.on('render-process-gone', (_event, details) => {
    // A hang timer from the dead renderer must not kill the one that replaces it.
    settle()
    const at = now()
    reloads = reloads.filter((time) => at - time < RECOVERY_WINDOW_MS)
    const recoverable = RECOVERABLE_REASONS.has(details.reason) && !win.isDestroyed()
    const recovering = recoverable && reloads.length < RECOVERY_MAX_RELOADS
    console.warn('window renderer gone', { reason: details.reason, exitCode: details.exitCode, recovering })
    if (!recoverable) return
    // Out of reloads: a static page with a link back, not a white window with no way out.
    if (recovering) reloads.push(at)
    const url = recovering ? appUrl : crashPage(appUrl)
    setTimeout(() => loadApp(win, url), RECOVERY_RELOAD_DELAY_MS)
  })
  win.on('unresponsive', () => {
    // In development a paused debugger also reads as unresponsive; only kill in a packaged app.
    if (!app.isPackaged) return
    hung ??= setTimeout(() => {
      hung = undefined
      if (!win.isDestroyed()) win.webContents.forcefullyCrashRenderer()
    }, UNRESPONSIVE_KILL_MS)
  })
  win.on('responsive', settle)
  win.on('closed', settle)
}

// `crashPage` is adapted from T3 Code (apps/desktop/src/app/DesktopStartupRecovery.ts
// `buildStartupRecoveryHtml`) at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License.
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/**
 * The page a window shows once its reloads run out: self-contained, no script
 * (its CSP allows only inline styles), Docs-styled, with one link back to the
 * app that `wireNavigation` turns into a load from main. The top strip drags
 * the window, since the title bar is hidden on macOS.
 */
export function crashPage(appUrl: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Docs</title><style>
html,body{margin:0;height:100%;background:#fff;color:#1f1f1f}
body{font:14px/1.5 'Google Sans',Roboto,Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center}
h1{margin:0;font-size:22px;font-weight:400}
.drag{position:fixed;top:0;left:0;right:0;height:40px;-webkit-app-region:drag}
a{display:inline-block;height:36px;line-height:36px;padding:0 24px;border:1px solid #747775;border-radius:18px;color:#0b57d0;font-weight:500;text-decoration:none}
a:hover{background:rgba(11,87,208,.08)}
</style></head><body>
<div class="drag"></div>
<h1>Docs couldn't load this document.</h1>
<a href="${escapeHtml(appUrl)}">Try again</a>
</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

// `denyPermissions` follows T3 Code's preview session handlers
// (apps/desktop/src/preview/BrowserSession.ts) at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License.
/** Copying a document link writes to the clipboard; camera, mic, location and the rest are refused. */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

/** Denies every permission request and check except the ones above. */
export function denyPermissions(
  session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
): void {
  session.setPermissionRequestHandler((_webContents, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission)),
  )
  session.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission))
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

/** Sent as a header on every app page as well as index.html's meta tag; keep the two the same. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: docs:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"

// The CSP header and resolving local images under an allowed root are adapted from T3 Code
// (apps/desktop/src/electron/ElectronProtocol.ts `withContentSecurityPolicy`, `serveDesktopAsset`)
// at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
function withContentSecurityPolicy(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** One of the open document's questions shows this image (a Codex history path, say). */
export function documentHasImage(snapshot: Snapshot | null, ref: string): boolean {
  return snapshot?.blocks.some((block) => block.kind === 'user' && block.images?.includes(ref) === true) ?? false
}

const forbidden = () => new Response('forbidden', { status: 403 })

/** `file` sits inside `root` once `..` segments are resolved. */
function isInside(root: string, file: string): boolean {
  return file === root || file.startsWith(root + sep)
}

/**
 * `docs://app/...` serves the renderer bundle; `docs://local/<encoded path>`
 * serves local images to <img>, but only pasted images (under userData/images)
 * and paths `isKnownImage` vouches for (the images in the open document).
 */
export function registerDocsProtocol(isKnownImage: (file: string) => boolean): void {
  const imagesDir = join(app.getPath('userData'), 'images')
  const appRoot = join(here, '../renderer')
  protocol.handle('docs', async (request) => {
    const url = new URL(request.url)
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    if (pathname.includes('\0')) return new Response('bad request', { status: 400 })
    if (url.host === 'local') {
      const ref = pathname.slice(1)
      const file = resolve(ref)
      if (!IMAGE_FILES.has(extname(file).toLowerCase())) return forbidden()
      if (!isInside(imagesDir, file) && !isKnownImage(ref)) return forbidden()
      return net.fetch(pathToFileURL(file).href)
    }
    const file = normalize(join(appRoot, (pathname === '/' ? '/index.html' : pathname).replace(/^\/+/, '')))
    if (!isInside(appRoot, file)) return forbidden()
    return withContentSecurityPolicy(await net.fetch(pathToFileURL(file).href))
  })
}
