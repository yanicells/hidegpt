import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { HideGptApi, SnapshotPatch } from '../shared/api'
import { EVENT_CHANNELS, SNAPSHOT_NOW_CHANNEL } from '../shared/channels'
import { emptySnapshot } from '../shared/model'

// A stand-in for Electron's renderer side: main's pushes are `emit`, and
// `sendSync` answers what main last published.
const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>()
  const exposed: { api?: unknown } = {}
  return {
    listeners,
    exposed,
    sendSync: vi.fn(),
    emit: (channel: string, value: unknown) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, value)
    },
  }
})

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: unknown) => (electron.exposed.api = api) },
  ipcRenderer: {
    sendSync: electron.sendSync,
    invoke: vi.fn(),
    on: (channel: string, listener: (event: unknown, value: unknown) => void) => {
      const set = electron.listeners.get(channel) ?? new Set()
      set.add(listener)
      electron.listeners.set(channel, set)
    },
    off: (channel: string, listener: (event: unknown, value: unknown) => void) => {
      electron.listeners.get(channel)?.delete(listener)
    },
  },
}))

const published = { ...emptySnapshot('/docs'), status: 'ready' as const }
let api: HideGptApi

beforeAll(async () => {
  electron.sendSync.mockImplementation((channel: string) => (channel === SNAPSHOT_NOW_CHANNEL ? published : undefined))
  await import('./index')
  api = electron.exposed.api as HideGptApi
})

describe('preload', () => {
  it('hands its snapshot to the page on the first read, then only relays patches', () => {
    const patch = (fields: SnapshotPatch['fields']): SnapshotPatch => ({ fields })
    const onSnapshot = EVENT_CHANNELS.onSnapshot

    // A patch that lands before the page's scripts run is in the first read.
    electron.emit(onSnapshot, patch({ title: 'Early' }))
    expect(api.getSnapshot()).toEqual({ ...published, title: 'Early' })

    // After it, the preload keeps nothing: no listener of its own remains.
    expect(electron.listeners.get(onSnapshot)?.size).toBe(0)
    const relayed: SnapshotPatch[] = []
    const stop = api.onSnapshot((value) => relayed.push(value))
    const late = patch({ title: 'Late' })
    electron.emit(onSnapshot, late)
    expect(relayed).toEqual([late])
    stop()

    // A later read asks main again instead of a copy.
    electron.sendSync.mockClear()
    expect(api.getSnapshot()).toEqual(published)
    expect(electron.sendSync).toHaveBeenCalledWith(SNAPSHOT_NOW_CHANNEL)
  })
})
