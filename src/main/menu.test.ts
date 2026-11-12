// Adapted from T3 Code (apps/desktop/src/window/DesktopApplicationMenu.test.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HOME } from '../shared/model'
import type { Snapshot } from '../shared/contracts'

const electronApp = vi.hoisted(() => ({ isPackaged: true }))
vi.mock('electron', () => ({ app: electronApp, Menu: {} }))

const { template } = await import('./menu')

type Item = Electron.MenuItemConstructorOptions

const home = { route: HOME } as unknown as Snapshot
const doc = { route: { kind: 'doc', id: 'd1' } } as unknown as Snapshot

function build(snap: Snapshot, platform: NodeJS.Platform = 'darwin') {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const handlers = { dispatch: vi.fn(), send: vi.fn(), reportProblem: vi.fn() }
  return { menu: template(snap, handlers), ...handlers }
}

/** Every item, submenus included. */
function flatten(items: readonly Item[]): Item[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])])
}

function find(items: readonly Item[], label: string): Item {
  const item = flatten(items).find((candidate) => candidate.label === label)
  if (!item) throw new Error(`No menu item "${label}"`)
  return item
}

const click = (item: Item) => item.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent)

afterEach(() => {
  vi.restoreAllMocks()
  electronApp.isPackaged = true
})

describe('menu', () => {
  it('reads like an installed Docs app: no Tools or Account menu', () => {
    expect(build(home).menu.map((item) => item.label ?? item.role)).toEqual([
      'Docs',
      'File',
      'Edit',
      'View',
      'History',
      'windowMenu',
      'help',
    ])
    expect(build(home, 'win32').menu.map((item) => item.label ?? item.role)).toEqual([
      'File',
      'Edit',
      'View',
      'History',
      'windowMenu',
      'help',
    ])
  })

  it('Find asks a document for its find bar and searches the documents on Home', () => {
    const inDoc = build(doc)
    click(find(inDoc.menu, 'Find…'))
    expect(inDoc.send).toHaveBeenCalledWith('find')
    expect(inDoc.dispatch).not.toHaveBeenCalled()

    const atHome = build(home)
    click(find(atHome.menu, 'Find…'))
    expect(atHome.send).toHaveBeenCalledWith('focusSearch')
  })

  it('binds Cmd+W only once, to File → Close', () => {
    const { menu } = build(doc)
    expect(flatten(menu).filter((item) => item.role === 'close')).toHaveLength(1)
    // An explicit submenu replaces Electron's default Window menu and the close role it adds off macOS.
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const windowMenu = build(doc, platform).menu.find((item) => item.role === 'windowMenu')
      expect(Array.isArray(windowMenu?.submenu), platform).toBe(true)
    }
  })

  it('binds every shortcut once, development items included', () => {
    electronApp.isPackaged = false
    for (const platform of ['darwin', 'win32'] as const) {
      const items = flatten(build(doc, platform).menu)
      // forceReload's default Shift+Cmd+R would collide with Rename…, so it must name its own.
      expect(items.find((item) => item.role === 'forceReload')?.accelerator, platform).toBe('Alt+CmdOrCtrl+R')
      const accelerators = items.flatMap((item) => (item.accelerator ? [item.accelerator] : []))
      expect(accelerators.length, platform).toBeGreaterThan(0)
      expect(new Set(accelerators).size, platform).toBe(accelerators.length)
    }
  })

  it('History → Back returns from a document to Home', () => {
    const atHome = build(home)
    expect(find(atHome.menu, 'Back').enabled).toBe(false)
    const inDoc = build(doc)
    const back = find(inDoc.menu, 'Back')
    expect(back.enabled).toBe(true)
    click(back)
    expect(inDoc.dispatch).toHaveBeenCalledWith({ op: 'goHome' })
  })

  it('Help → Report a problem… shows the saved reports', () => {
    const { menu, reportProblem } = build(home)
    const help = menu.find((item) => item.role === 'help')
    expect((help!.submenu as Item[]).map((item) => item.label)).toEqual(['Report a problem…'])
    click(find(menu, 'Report a problem…'))
    expect(reportProblem).toHaveBeenCalledOnce()
  })
})
