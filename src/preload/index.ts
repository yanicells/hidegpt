// Adapted from T3 Code (apps/desktop/src/preload.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { contextBridge, ipcRenderer } from 'electron'

import type { EventValue, HideGptApi, SnapshotPatch } from '../shared/api'
import { EVENT_CHANNELS, INVOKE_CHANNELS, SNAPSHOT_NOW_CHANNEL } from '../shared/channels'
import { emptySnapshot, type Snapshot } from '../shared/model'
import { applySnapshotPatch } from '../shared/snapshot-patch'

// The preload only relays: patches pass straight to the page, which applies
// them itself. It holds a snapshot only until the page first reads it: the
// copy starts as what main last published (so the first paint is the real
// library) and takes the patches that land before the page's scripts run.
// That first read hands it over and stops tracking, and the page subscribes
// in the same task, so every patch is applied exactly once.
let handover: Snapshot | null = ipcRenderer.sendSync(SNAPSHOT_NOW_CHANNEL) ?? emptySnapshot()

const track = (_event: Electron.IpcRendererEvent, patch: SnapshotPatch) => {
  if (handover) handover = applySnapshotPatch(handover, patch)
}
ipcRenderer.on(EVENT_CHANNELS.onSnapshot, track)

/** The first read hands over the tracked copy; a later one asks main for what it last published. */
function getSnapshot(): Snapshot {
  if (!handover) return ipcRenderer.sendSync(SNAPSHOT_NOW_CHANNEL) ?? emptySnapshot()
  const snapshot = handover
  handover = null
  ipcRenderer.off(EVENT_CHANNELS.onSnapshot, track)
  return snapshot
}

/** A subscriber for one `IpcEvents` row; main is trusted, so values pass through as sent. */
const subscribe =
  <K extends keyof typeof EVENT_CHANNELS>(name: K) =>
  (handler: (value: EventValue<K>) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: EventValue<K>) => handler(value)
    ipcRenderer.on(EVENT_CHANNELS[name], listener)
    return () => {
      ipcRenderer.off(EVENT_CHANNELS[name], listener)
    }
  }

const api: HideGptApi = {
  getSnapshot,
  onSnapshot: subscribe('onSnapshot'),
  onMenu: subscribe('onMenu'),
  dispatch: (command) => ipcRenderer.invoke(INVOKE_CHANNELS.dispatch, command),
  pickDirectory: () => ipcRenderer.invoke(INVOKE_CHANNELS.pickDirectory),
  saveImage: (request) => ipcRenderer.invoke(INVOKE_CHANNELS.saveImage, request),
  platform: process.platform,
}

contextBridge.exposeInMainWorld('hidegpt', api)
