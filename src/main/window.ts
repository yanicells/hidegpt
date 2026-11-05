/// <reference types="electron-vite/node" />
import { BrowserWindow, app, net, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
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
    // A plain native title bar, like a browser window: nothing overlaps the Docs logo.
    titleBarStyle: 'default',
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
  goHome: () => void
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
  // An occluded window stops painting and capturePage returns stale frames.
  win.webContents.setBackgroundThrottling(false)
  win.setAlwaysOnTop(true)
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
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const pause = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))
  const shot = async (name: string) => {
    await pause()
    win.webContents.invalidate()
    await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
    writeFileSync(join(dir, `${name}.png`), (await win.capturePage()).toPNG())
  }
  const centre = async (testId: string): Promise<{ x: number; y: number }> =>
    js(`(() => {
      const el = document.querySelector('[data-testid="${testId}"]')
      if (!el) throw new Error('missing ${testId}')
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  // Real mouse input, so menus and focus behave as they do for a person.
  const clickAt = async ({ x, y }: { x: number; y: number }) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await pause(200)
  }
  const click = async (testId: string) => clickAt(await centre(testId))
  const waitFor = (selector: string, what: string) =>
    js(`new Promise((resolve, reject) => {
      const started = Date.now()
      const check = () => {
        if (document.querySelector(${JSON.stringify(selector)})) resolve(true)
        else if (Date.now() - started > 8000) reject(new Error(${JSON.stringify(`${what} did not appear`)}))
        else setTimeout(check, 50)
      }
      check()
    })`)
  // Menus close on a click in empty canvas at the window's left edge.
  const dismiss = () => clickAt({ x: 6, y: 520 })
  // Park the pointer there so a button that swapped in under it doesn't show hover.
  const rest = async () => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 6, y: 520 })
    await pause(150)
  }
  const hover = async (testId: string) => {
    const { x, y } = await centre(testId)
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    await pause(300)
  }

  // Fonts are bundled; record what actually loaded so reviews can verify it.
  const fonts = await js(`document.fonts.ready.then(() => ({
    loaded: Array.from(document.fonts).filter((face) => face.status === 'loaded').map((face) => face.family + ' ' + face.weight),
    ui: getComputedStyle(document.body).fontFamily,
    googleSansFlex: document.fonts.check('14px "Google Sans Flex Variable"'),
    roboto: document.fonts.check('12px Roboto'),
  }))`)
  writeFileSync(join(dir, 'fonts.json'), JSON.stringify(fonts, null, 2))

  await shot('home')
  await click('home-location')
  await shot('home-location-menu')
  await dismiss()
  await click('open-picker')
  await shot('folder-picker')
  await click('new-folder')
  await shot('folder-new')
  await js(`document.querySelector('[data-slot="dialog-popup"] .text-button').click()`)
  await pause()
  await js(`document.querySelector('[data-slot="dialog-close"]')?.click()`)
  await pause()
  await click('menu-account')
  await shot('account-menu')
  await dismiss()
  await clickAt(await js(`(() => { const r = document.querySelector('[aria-label="List view"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`))
  await rest()
  await shot('home-list')
  await js(`document.querySelector('[aria-label="Grid view"]').click()`)

  // Blank document creates immediately, like Docs, and focuses the page.
  await click('new-doc')
  await js(`new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      const composer = document.querySelector('[data-testid="composer"]')
      if (composer && document.activeElement === composer) resolve(true)
      else if (Date.now() - started > 8000) reject(new Error('New document composer did not receive focus'))
      else setTimeout(check, 50)
    }
    check()
  })`)
  await shot('new-document-ready')

  const first = session.snapshot.threads[0]
  if (first) await session.openThread(first.id)
  else await session.newDocument()
  await waitFor('[data-testid="document"] .doc-block', 'document')
  await shot('document')
  // Docs' own dark hover label, not the system tooltip.
  await hover('chip-model')
  await pause(900)
  await shot('tooltip')
  await rest()
  for (const [trigger, name] of [
    ['menu-file', 'menu-file'],
    ['menu-view', 'menu-view'],
    ['chip-zoom', 'menu-zoom'],
    ['chip-model', 'menu-style'],
    ['chip-effort', 'menu-font'],
    ['chip-speed', 'menu-size'],
    ['chip-mode', 'menu-mode'],
    ['toolbar-more', 'toolbar-more'],
    ['share', 'share-dialog'],
    ['share-menu', 'menu-share'],
    ['menu-account', 'account-menu-doc'],
  ] as const) {
    await click(trigger)
    // Font-menu faces load the first time a row shows them.
    if (trigger === 'chip-effort') await js('document.fonts.ready.then(() => true)')
    await shot(name)
    if (trigger === 'menu-file') {
      await hover('action-new')
      await shot('menu-file-new')
    }
    if (trigger === 'chip-model') {
      await hover('pick-gpt-5.6-sol')
      await pause(600)
      await shot('menu-style-cascade')
      await click('pick-options')
      await shot('menu-style-options')
    }
    await dismiss()
  }
  win.setSize(760, 700)
  await shot('document-narrow')
  await click('toolbar-more')
  await shot('toolbar-more-narrow')
  await dismiss()
  await session.goHome()
  await shot('home-narrow')
  win.setSize(1280, 840)

  // Switching "accounts" swaps the document library.
  await click('menu-account')
  await click('library-opencode')
  await waitFor('[data-testid="docs-home"]', 'library home')
  await js(`new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      if (!document.querySelector('.top-progress')) resolve(true)
      else if (Date.now() - started > 8000) reject(new Error('Library switch did not complete'))
      else setTimeout(check, 50)
    }
    check()
  })`)
  await shot('opencode-home')
  await click('menu-account')
  await shot('account-menu-opencode')
  await click('library-codex')
  await pause(300)
  const returnedHome = await js(`!!document.querySelector('.route-home .home')`)
  if (!returnedHome) throw new Error('Switching back to Codex did not return to its library')
  app.quit()
}
