import type { Command, CommandResult, MenuAction, Snapshot, SnapshotPatch } from './contracts'

export type { Command, CommandResult, MenuAction, SnapshotPatch } from './contracts'

/** The `window.hidegpt` bridge the preload script exposes. */
export type HideGptApi = {
  /** The whole current snapshot; read once at startup, then patches follow. */
  getSnapshot: () => Snapshot
  /** Live updates arrive as patches against the last snapshot. */
  onSnapshot: (handler: (patch: SnapshotPatch) => void) => () => void
  onMenu: (handler: (action: MenuAction) => void) => () => void
  /** Settles with the command's result; a failure carries a message to show. */
  dispatch: (command: Command) => Promise<CommandResult>
  pickDirectory: () => Promise<string | null>
  /** Stores pasted image bytes on disk and returns the file path to attach. */
  saveImage: (bytes: Uint8Array, mime: string) => Promise<string>
  platform: NodeJS.Platform
}

type ApiMethod = { [K in keyof HideGptApi]: HideGptApi[K] extends (...args: never) => unknown ? K : never }[keyof HideGptApi]

// A record, so the compiler rejects a method missing from the list as well as an extra one.
const methods: Record<ApiMethod, true> = {
  getSnapshot: true,
  onSnapshot: true,
  onMenu: true,
  dispatch: true,
  pickDirectory: true,
  saveImage: true,
}

/** Every function on `window.hidegpt`; `pnpm dist` checks the built preload exposes them all. */
export const HIDEGPT_API_METHODS = Object.keys(methods) as ReadonlyArray<ApiMethod>

declare global {
  interface Window {
    hidegpt: HideGptApi
  }
}
