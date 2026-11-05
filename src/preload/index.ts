import { contextBridge, ipcRenderer } from 'electron'

import type { Command, CommandResult, HideGptApi, MenuAction, SnapshotPatch } from '../shared/api'
import { emptySnapshot, type Snapshot } from '../shared/model'
import { applySnapshotPatch } from '../shared/snapshot-patch'

// The preload keeps an assembled copy for getSnapshot(); live updates cross
// the context bridge as small patches that the renderer applies itself. The
// copy starts as what main last published, so the first paint is the real
// library, and main sends a whole-snapshot patch once the page loads.
let snapshot: Snapshot = (ipcRenderer.sendSync('snapshot-now') as Snapshot | null) ?? emptySnapshot()

ipcRenderer.on('snapshot', (_event, patch: SnapshotPatch) => {
  snapshot = applySnapshotPatch(snapshot, patch)
})

const subscribe =
  <T>(channel: string) =>
  (handler: (value: T) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: T) => handler(value)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.off(channel, listener)
    }
  }

const api: HideGptApi = {
  getSnapshot: () => snapshot,
  onSnapshot: subscribe<SnapshotPatch>('snapshot'),
  onMenu: subscribe<MenuAction>('menu'),
  dispatch: (command: Command) => ipcRenderer.invoke('command', command) as Promise<CommandResult>,
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  saveImage: async (bytes: Uint8Array, mime: string) => {
    const result = (await ipcRenderer.invoke('save-image', [bytes, mime])) as { ok: true; path: string } | { ok: false; error: string }
    if (!result.ok) throw new Error(result.error)
    return result.path
  },
  platform: process.platform,
}

contextBridge.exposeInMainWorld('hidegpt', api)
