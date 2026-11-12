// The protocol and recovery tests follow T3 Code's ElectronProtocol.test.ts and ElectronShell.test.ts
// (apps/desktop/src/electron/) at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { BrowserWindow, Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptySnapshot, type Snapshot } from '../shared/model'

const { handleMock, netFetchMock } = vi.hoisted(() => ({ handleMock: vi.fn(), netFetchMock: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: () => '/data', isPackaged: true },
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock },
  screen: {},
  shell: { openExternal: vi.fn() },
  BrowserWindow: class {},
}))

import {
  CONTENT_SECURITY_POLICY,
  denyPermissions,
  documentHasImage,
  isAppNavigation,
  recoverRenderer,
  registerDocsProtocol,
  safeExternalUrl,
} from './window'

describe('navigation guards', () => {
  it('keeps reloads and dev-server navigations in the window', () => {
    expect(isAppNavigation('docs://app/index.html', 'docs://app/index.html#x')).toBe(true)
    expect(isAppNavigation('http://localhost:5173/', 'http://localhost:5173/src/main.tsx')).toBe(true)
    expect(isAppNavigation('docs://app/index.html', 'docs://local/%2Fetc%2Fpasswd')).toBe(false)
    expect(isAppNavigation('docs://app/index.html', 'https://example.com/')).toBe(false)
    expect(isAppNavigation('docs://app/index.html', 'not a url')).toBe(false)
  })

  it('sends only web and mail links out of the app', () => {
    expect(safeExternalUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(safeExternalUrl('mailto:me@example.com')).toBe('mailto:me@example.com')
    for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'docs://app/index.html', 'vscode://x', 'nope']) {
      expect(safeExternalUrl(raw)).toBeNull()
    }
  })
})

describe('docs:// protocol', () => {
  let handler: (request: Request) => Promise<Response>
  const known = new Set(['/Users/me/Desktop/chart.png'])

  beforeEach(() => {
    handleMock.mockReset()
    netFetchMock.mockReset()
    handleMock.mockImplementation((_scheme: string, next: typeof handler) => {
      handler = next
    })
    netFetchMock.mockImplementation(async () => new Response('bytes', { headers: { 'content-type': 'text/html' } }))
    registerDocsProtocol((ref) => known.has(ref))
  })

  const local = (path: string) => handler(new Request(`docs://local/${encodeURIComponent(path)}`))

  it('serves pasted images and the open document’s images', async () => {
    expect((await local('/data/images/a.png')).status).toBe(200)
    expect((await local('/Users/me/Desktop/chart.png')).status).toBe(200)
    expect(netFetchMock.mock.calls.map(([url]) => url)).toEqual([
      pathToFileURL('/data/images/a.png').href,
      pathToFileURL('/Users/me/Desktop/chart.png').href,
    ])
  })

  it('refuses any other file on disk', async () => {
    expect((await local('/Users/me/Desktop/private.png')).status).toBe(403)
    expect((await local('/data/images/../secrets/key.png')).status).toBe(403)
    expect((await local('/data/images/notes.txt')).status).toBe(403)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('keeps app requests inside the bundle and sends the CSP header', async () => {
    const page = await handler(new Request('docs://app/'))
    expect(page.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY)
    expect(netFetchMock.mock.calls[0]?.[0]).toMatch(/\/renderer\/index\.html$/)
    expect((await handler(new Request('docs://app/%2e%2e%2f%2e%2e%2fpackage.json'))).status).toBe(403)
    expect((await handler(new Request('docs://app/%E0%A4%A'))).status).toBe(400)
  })

  it('sends the same CSP as index.html’s meta tag', () => {
    const html = readFileSync(join(import.meta.dirname, '../renderer/index.html'), 'utf8')
    expect(html).toContain(`content="${CONTENT_SECURITY_POLICY}"`)
  })
})

describe('documentHasImage', () => {
  it('finds images only in the open document’s questions', () => {
    const snapshot: Snapshot = {
      ...emptySnapshot(),
      blocks: [{ kind: 'user', id: 'u1', text: 'Look', images: ['/tmp/a.png'] }],
    }
    expect(documentHasImage(snapshot, '/tmp/a.png')).toBe(true)
    expect(documentHasImage(snapshot, '/tmp/b.png')).toBe(false)
    expect(documentHasImage(null, '/tmp/a.png')).toBe(false)
  })
})

describe('denyPermissions', () => {
  it('denies every permission by default and allows copying', () => {
    let request: ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void) | undefined
    let check: ((wc: unknown, permission: string) => boolean) | undefined
    const session = {
      setPermissionRequestHandler: (next: typeof request) => void (request = next),
      setPermissionCheckHandler: (next: typeof check) => void (check = next),
    }
    denyPermissions(session as unknown as Session)

    const granted = (permission: string) => {
      let answer: boolean | undefined
      request?.(null, permission, (value) => (answer = value))
      return answer
    }
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'unknown']) {
      expect(granted(permission)).toBe(false)
      expect(check?.(null, permission)).toBe(false)
    }
    expect(granted('clipboard-sanitized-write')).toBe(true)
    expect(check?.(null, 'clipboard-sanitized-write')).toBe(true)
  })
})

describe('recoverRenderer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function fakeWindow() {
    const win = Object.assign(new EventEmitter(), {
      destroyed: false,
      isDestroyed: () => win.destroyed,
      loadURL: vi.fn(async (_url: string) => undefined),
      webContents: Object.assign(new EventEmitter(), { forcefullyCrashRenderer: vi.fn() }),
    })
    recoverRenderer(win as unknown as BrowserWindow, 'docs://app/index.html', () => Date.now())
    const gone = (reason: string) => win.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 })
    return { win, gone }
  }

  it('reloads a crashed renderer three times a minute, then shows a page with a way back', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { win, gone } = fakeWindow()
    const loaded = () => win.loadURL.mock.calls.map(([url]) => url)
    for (let i = 0; i < 4; i++) {
      gone(i % 2 ? 'oom' : 'crashed')
      vi.advanceTimersByTime(1_000)
    }
    expect(loaded().slice(0, 3)).toEqual(Array(3).fill('docs://app/index.html'))
    const page = loaded()[3] ?? ''
    expect(page.startsWith('data:text/html')).toBe(true)
    const html = decodeURIComponent(page.slice(page.indexOf(',') + 1))
    expect(html).toContain('<a href="docs://app/index.html">Try again</a>')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('<script')
    expect(isAppNavigation('docs://app/index.html', 'docs://app/index.html')).toBe(true)

    vi.advanceTimersByTime(60_000)
    gone('crashed')
    vi.advanceTimersByTime(1_000)
    expect(loaded()[4]).toBe('docs://app/index.html')
  })

  it('logs a reload that fails instead of leaving it unhandled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { win, gone } = fakeWindow()
    win.loadURL.mockRejectedValueOnce(new Error('ERR_ABORTED'))
    gone('crashed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(warn).toHaveBeenCalledWith('window reload failed', expect.any(Error))
  })

  it('leaves a clean exit or a closed window alone', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { win, gone } = fakeWindow()
    gone('clean-exit')
    vi.advanceTimersByTime(1_000)
    gone('crashed')
    win.destroyed = true
    vi.advanceTimersByTime(1_000)
    expect(win.loadURL).not.toHaveBeenCalled()
  })

  it('kills a renderer that stays unresponsive, but not one that recovers', () => {
    const { win } = fakeWindow()
    win.emit('unresponsive')
    vi.advanceTimersByTime(10_000)
    win.emit('responsive')
    vi.advanceTimersByTime(10_000)
    expect(win.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled()

    win.emit('unresponsive')
    vi.advanceTimersByTime(15_000)
    expect(win.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
  })
})
