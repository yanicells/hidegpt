// Adapted from T3 Code (apps/desktop/src/preload.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { contextBridge, ipcRenderer } from 'electron'

import type {
  EventValue,
  HideGptApi,
  InvokePayload,
  InvokeResult,
  SequencedSnapshot,
  SnapshotPatch,
} from '../shared/api'
import type { IpcInvoke } from '../shared/contracts'
import { EVENT_CHANNELS, INVOKE_CHANNELS, SNAPSHOT_NOW_CHANNEL } from '../shared/channels'
import { emptySnapshot } from '../shared/model'
import { applyPatchOnce } from '../shared/snapshot-patch'

/** What main last published and its `seq`; seq 0 (nothing yet) before main has published. */
const readFromMain = (): SequencedSnapshot =>
  ipcRenderer.sendSync(SNAPSHOT_NOW_CHANNEL) ?? { snapshot: emptySnapshot(), seq: 0 }

// The preload only relays: patches pass straight to the page, which applies
// them itself. It holds a snapshot only until the page first reads it: the
// copy starts as what main last published (so the first paint is the real
// library) and takes the patches that land before the page's scripts run.
// Patches are numbered, so one that main sent before answering the read
// (already in the copy) and delivered after it is skipped, not applied twice.
// The first read hands the copy over and stops tracking.
let handover: SequencedSnapshot | null = readFromMain()

const track = (_event: Electron.IpcRendererEvent, patch: SnapshotPatch) => {
  if (handover) handover = applyPatchOnce(handover, patch)
}
ipcRenderer.on(EVENT_CHANNELS.onSnapshot, track)

/** The first read hands over the tracked copy; a later one asks main again. */
function getSnapshot(): SequencedSnapshot {
  if (!handover) return readFromMain()
  const current = handover
  handover = null
  ipcRenderer.off(EVENT_CHANNELS.onSnapshot, track)
  return current
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

/**
 * Invokes one `IpcInvoke` row by name. The name picks both the channel and the
 * result type, so a member wired to the wrong channel fails typecheck.
 * `ipcRenderer.invoke` itself returns `any`, as in T3's preload; main answers
 * with the row's `result` or `invalid`, both checked there.
 */
const invoke = <K extends keyof typeof IpcInvoke>(
  name: K,
  ...payload: InvokePayload<K> extends undefined ? [] : [InvokePayload<K>]
): Promise<InvokeResult<K>> => ipcRenderer.invoke(INVOKE_CHANNELS[name], ...payload)

const api: HideGptApi = {
  getSnapshot,
  onSnapshot: subscribe('onSnapshot'),
  onMenu: subscribe('onMenu'),
  dispatch: (command) => invoke('dispatch', command),
  pickDirectory: () => invoke('pickDirectory'),
  saveImage: (request) => invoke('saveImage', request),
  platform: process.platform,
}

contextBridge.exposeInMainWorld('hidegpt', api)
