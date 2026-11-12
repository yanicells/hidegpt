// Adapted from T3 Code (apps/desktop/src/ipc/channels.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

/**
 * IPC channel names, keyed by the `window.hidegpt` member that uses them.
 * Plain strings with no Effect import, so the sandboxed preload can load them;
 * the schemas for each channel live in the `Ipc*` tables in `./contracts`.
 */

/** Renderer → main requests (`ipcRenderer.invoke`). */
export const INVOKE_CHANNELS = {
  dispatch: 'command',
  pickDirectory: 'pick-directory',
  saveImage: 'save-image',
} as const

/** Main → renderer pushes (`webContents.send`). */
export const EVENT_CHANNELS = {
  onSnapshot: 'snapshot',
  onMenu: 'menu',
} as const

/** The one synchronous read: what main last published, for the preload's first paint. */
export const SNAPSHOT_NOW_CHANNEL = 'snapshot-now'
