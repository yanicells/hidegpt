import { describe, expect, it, vi } from 'vitest'

import { HOME } from '../shared/model'
import type { Snapshot } from '../shared/contracts'

vi.mock('electron', () => ({ app: { isPackaged: true }, Menu: {} }))

const { template } = await import('./menu')

describe('menu', () => {
  it('Help → Report a problem… shows the saved reports', () => {
    const reportProblem = vi.fn()
    const snap = { provider: 'codex', capabilities: { login: false }, account: null, mcpServers: [], route: HOME } as unknown as Snapshot
    const help = template(snap, { dispatch: vi.fn(), send: vi.fn(), reportProblem }).find((item) => item.role === 'help')
    const items = help?.submenu as Electron.MenuItemConstructorOptions[]
    expect(items.map((item) => item.label)).toEqual(['Report a problem…'])
    items[0]!.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent)
    expect(reportProblem).toHaveBeenCalledOnce()
  })
})
