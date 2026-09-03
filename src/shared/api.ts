import type { Provider, Snapshot } from '../codex/types'

export type Command =
  | { op: 'newDocument' }
  | { op: 'openThread'; threadId: string }
  | { op: 'goHome' }
  | { op: 'send'; text: string }
  | { op: 'interrupt' }
  | { op: 'login' }
  | { op: 'logout' }
  | { op: 'connectMcp'; name: string }
  | { op: 'setSearch'; value: string }
  | { op: 'applySearch' }
  | { op: 'setModel'; model: string }
  | { op: 'setEffort'; effort: string }
  | { op: 'setSpeed'; speed: string | null }
  | { op: 'setCollaborationMode'; name: string }
  | { op: 'openFolder' }
  | { op: 'loadOlderTurns' }
  | { op: 'resolveApproval'; blockId: string; accept: boolean }
  | { op: 'setApprovalDraft'; blockId: string; key: string; value: string }
  | { op: 'setDocumentName'; name: string }
  | { op: 'setProvider'; provider: Provider }
  | { op: 'refresh' }

export type MenuAction = 'rename' | 'grid' | 'list' | 'newDocument' | 'goHome' | 'focusSearch'

export type HideGptApi = {
  getSnapshot: () => Snapshot
  onSnapshot: (handler: (snapshot: Snapshot) => void) => () => void
  onMenu: (handler: (action: MenuAction) => void) => () => void
  dispatch: (command: Command) => Promise<void>
  platform: NodeJS.Platform
}

declare global {
  interface Window {
    hidegpt: HideGptApi
  }
}
