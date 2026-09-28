import { contextBridge, ipcRenderer } from 'electron'

import type { Snapshot } from '../codex/types'
import { emptySnapshot } from '../codex/types'
import type { Command, MenuAction } from '../shared/api'
import { applySnapshotPatch, type SnapshotPatch } from '../shared/snapshot-patch'

// The preload keeps an assembled copy only for getSnapshot(); live updates
// cross the context bridge as small patches that the renderer applies itself.
let snapshot: Snapshot = emptySnapshot()

ipcRenderer.on('snapshot', (_event, patch: SnapshotPatch) => {
  snapshot = applySnapshotPatch(snapshot, patch)
})

contextBridge.exposeInMainWorld('hidegpt', {
  getSnapshot: () => snapshot,
  onSnapshot: (handler: (patch: SnapshotPatch) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, patch: SnapshotPatch) => handler(patch)
    ipcRenderer.on('snapshot', listener)
    return () => {
      ipcRenderer.off('snapshot', listener)
    }
  },
  onMenu: (handler: (action: MenuAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: MenuAction) => handler(action)
    ipcRenderer.on('menu', listener)
    return () => {
      ipcRenderer.off('menu', listener)
    }
  },
  dispatch: (command: Command) => ipcRenderer.invoke('command', command),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  saveImage: (bytes: Uint8Array, mime: string) => ipcRenderer.invoke('save-image', bytes, mime),
  platform: process.platform,
})
