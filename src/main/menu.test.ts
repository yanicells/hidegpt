// Adapted from T3 Code (apps/desktop/src/window/DesktopApplicationMenu.test.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { afterEach, describe, expect, it, vi } from 'vitest'

const electronApp = vi.hoisted(() => ({ isPackaged: true }))
vi.mock('electron', () => ({ app: electronApp, Menu: {} }))

const { template } = await import('./menu')

type Item = Electron.MenuItemConstructorOptions

const home = 'home'
const doc = 'doc'

function build(page: typeof home | typeof doc, platform: NodeJS.Platform = 'darwin') {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const handlers = { dispatch: vi.fn(), send: vi.fn(), reportProblem: vi.fn() }
  return { menu: template(page, handlers), ...handlers }
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

/**
 * The shortcut each role brings when it names none, from Electron's
 * `menu-item-roles.ts`. A role missing here fails the test below, so a new role
 * cannot slip in an unchecked shortcut.
 */
const ROLE_SHORTCUTS: Record<string, (platform: NodeJS.Platform) => string | undefined> = {
  about: () => undefined,
  close: () => 'CmdOrCtrl+W',
  copy: () => 'CmdOrCtrl+C',
  cut: () => 'CmdOrCtrl+X',
  forceReload: () => 'Shift+CmdOrCtrl+R',
  front: () => undefined,
  help: () => undefined,
  hide: () => 'Command+H',
  hideOthers: () => 'Command+Alt+H',
  minimize: () => 'CmdOrCtrl+M',
  paste: () => 'CmdOrCtrl+V',
  quit: (platform) => (platform === 'win32' ? undefined : 'CmdOrCtrl+Q'),
  redo: (platform) => (platform === 'win32' ? 'Control+Y' : 'Shift+CmdOrCtrl+Z'),
  reload: () => 'CmdOrCtrl+R',
  resetZoom: () => 'CmdOrCtrl+0',
  selectAll: () => 'CmdOrCtrl+A',
  toggleDevTools: (platform) => (platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I'),
  togglefullscreen: (platform) => (platform === 'darwin' ? 'Control+Command+F' : 'F11'),
  undo: () => 'CmdOrCtrl+Z',
  unhide: () => undefined,
  windowMenu: () => undefined,
  zoom: () => undefined,
  zoomIn: () => 'CmdOrCtrl+Plus',
  zoomOut: () => 'CmdOrCtrl+-',
}

/** One spelling per key chord, so `Command+H` and `CmdOrCtrl+H` compare equal on macOS. */
function chord(accelerator: string, isMac: boolean): string {
  const names: Record<string, string> = {
    cmdorctrl: isMac ? 'cmd' : 'ctrl',
    commandorcontrol: isMac ? 'cmd' : 'ctrl',
    command: 'cmd',
    cmd: 'cmd',
    control: 'ctrl',
    ctrl: 'ctrl',
    option: 'alt',
  }
  const parts = accelerator.toLowerCase().split('+')
  const key = parts.pop()!
  return [...parts.map((part) => names[part] ?? part).sort(), key].join('+')
}

/** The shortcut an item answers to: its own, else its role's. */
function shortcut(item: Item, platform: NodeJS.Platform): string | undefined {
  const isMac = platform === 'darwin'
  if (item.accelerator) return chord(item.accelerator, isMac)
  if (!item.role) return undefined
  const fallback = ROLE_SHORTCUTS[item.role]
  if (!fallback) throw new Error(`Add role "${item.role}" and its default shortcut to ROLE_SHORTCUTS`)
  const accelerator = fallback(platform)
  return accelerator && chord(accelerator, isMac)
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

  it('binds every shortcut once, role defaults and development items included', () => {
    electronApp.isPackaged = false
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const isMac = platform === 'darwin'
      const shortcuts = flatten(build(doc, platform).menu).flatMap((item) => shortcut(item, platform) ?? [])
      for (const key of ['CmdOrCtrl+Z', 'CmdOrCtrl+=', 'CmdOrCtrl+Plus', 'CmdOrCtrl+numadd']) {
        expect(shortcuts, platform).toContain(chord(key, isMac))
      }
      expect(
        shortcuts.filter((key, index) => shortcuts.indexOf(key) !== index),
        platform,
      ).toEqual([])
    }
  })

  it('zooms in on Cmd+= and keeps the other zoom keys out of sight', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const zoom = flatten(build(doc, platform).menu).filter((item) =>
        ['zoomIn', 'zoomOut', 'resetZoom'].includes(item.role ?? ''),
      )
      const visible = zoom.filter((item) => item.visible !== false)
      expect(
        visible.map((item) => [item.role, item.accelerator]),
        platform,
      ).toEqual([
        ['resetZoom', undefined],
        ['zoomIn', 'CmdOrCtrl+='],
        ['zoomOut', undefined],
      ])
      const hidden = zoom.filter((item) => item.visible === false).map((item) => item.accelerator)
      expect(hidden, platform).toEqual([
        'CmdOrCtrl+Plus',
        ...(platform === 'darwin' ? ['CmdOrCtrl+Shift+='] : []),
        'CmdOrCtrl+num0',
        'CmdOrCtrl+numadd',
        'CmdOrCtrl+numsub',
      ])
    }
  })

  it('leaves Cmd+[ to the page, where it decreases indent', () => {
    expect(find(build(doc).menu, 'Back').accelerator).toBeUndefined()
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
