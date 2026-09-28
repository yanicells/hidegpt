import { useEffect, useSyncExternalStore } from 'react'

import { emptySnapshot, type Snapshot } from '../../codex/types'
import type { Command, MenuAction } from '../../shared/api'
import { applySnapshotPatch } from '../../shared/snapshot-patch'

let snapshot: Snapshot = emptySnapshot()

function getSnapshot(): Snapshot {
  return snapshot
}

function subscribe(onChange: () => void): () => void {
  if (!window.hidegpt) return () => {}
  snapshot = window.hidegpt.getSnapshot()
  return window.hidegpt.onSnapshot((patch) => {
    snapshot = applySnapshotPatch(snapshot, patch)
    onChange()
  })
}

export function useSnapshot(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function dispatch(command: Command): void {
  void window.hidegpt?.dispatch(command)
}

export function useMenuAction(handler: (action: MenuAction) => void): void {
  useEffect(() => {
    if (!window.hidegpt) return
    return window.hidegpt.onMenu(handler)
  }, [handler])
}

export function platform(): NodeJS.Platform {
  return window.hidegpt?.platform ?? 'darwin'
}
