import { contextBridge, ipcRenderer } from 'electron'

import type { Snapshot } from '../codex/types'
import { emptySnapshot } from '../codex/types'
import type { Command, MenuAction } from '../shared/api'

let snapshot: Snapshot = emptySnapshot()

ipcRenderer.on('snapshot', (_event, next: Snapshot) => {
  snapshot = next
})

contextBridge.exposeInMainWorld('hidegpt', {
  getSnapshot: () => snapshot,
  onSnapshot: (handler: (next: Snapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, next: Snapshot) => {
      snapshot = next
      handler(next)
    }
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
  platform: process.platform,
})
