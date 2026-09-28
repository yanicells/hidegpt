import type { Provider, Snapshot } from '../codex/types'

export type NewDocumentOptions = { projectId?: string | null; cwd?: string; title?: string }

export type Command =
  | ({ op: 'newDocument' } & NewDocumentOptions)
  | { op: 'createProject'; name: string; cwd: string }
  | { op: 'openThread'; threadId: string }
  | { op: 'goHome' }
  | { op: 'send'; text: string; skill?: string; images?: string[] }
  | { op: 'interrupt' }
  | { op: 'login' }
  | { op: 'logout' }
  | { op: 'connectMcp'; name: string }
  | { op: 'setSearch'; value: string }
  | { op: 'applySearch' }
  | { op: 'setModel'; model: string }
  | { op: 'setEffort'; effort: string }
  | { op: 'setServiceTier'; serviceTier: string | null }
  | { op: 'setCollaborationMode'; name: string }
  | { op: 'openFolder' }
  | { op: 'loadOlderTurns' }
  | { op: 'resolveApproval'; blockId: string; accept: boolean }
  | { op: 'setApprovalDraft'; blockId: string; key: string; value: string }
  | { op: 'setDocumentName'; name: string }
  | { op: 'setProvider'; provider: Provider; home?: boolean }
  | { op: 'refresh' }

/** Extras a message can carry besides its text. */
export type SendExtras = { skill?: string; images?: string[] }

export type MenuAction = 'rename' | 'grid' | 'list' | 'newDocument' | 'goHome' | 'focusSearch'

export type HideGptApi = {
  getSnapshot: () => Snapshot
  onSnapshot: (handler: (snapshot: Snapshot) => void) => () => void
  onMenu: (handler: (action: MenuAction) => void) => () => void
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
