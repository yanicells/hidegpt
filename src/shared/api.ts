import type { Command, MenuAction, Snapshot, SnapshotPatch } from './contracts'

export type { Command, CommandResult, MenuAction, SnapshotPatch } from './contracts'

/** The `window.hidegpt` bridge the preload script exposes. */
export type HideGptApi = {
  /** The whole current snapshot; read once at startup, then patches follow. */
  getSnapshot: () => Snapshot
  /** Live updates arrive as patches against the last snapshot. */
  onSnapshot: (handler: (patch: SnapshotPatch) => void) => () => void
  onMenu: (handler: (action: MenuAction) => void) => () => void
  /** Rejects with the command's error message when it fails. */
  dispatch: (command: Command) => Promise<void>
  pickDirectory: () => Promise<string | null>
  /** Stores pasted image bytes on disk and returns the file path to attach. */
  saveImage: (bytes: Uint8Array, mime: string) => Promise<string>
  platform: NodeJS.Platform
}

declare global {
  interface Window {
    hidegpt: HideGptApi
  }
}
