import { useEffect, useSyncExternalStore } from 'react'

import type { Command, CommandResult, MenuAction } from '../../shared/api'
import { errorMessage } from '../../shared/labels'
import { emptySnapshot, type Snapshot } from '../../shared/model'
import { applySnapshotPatch } from '../../shared/snapshot-patch'

// Read the preload's assembled copy right away, so the first paint is the real
// library rather than an empty one.
let snapshot: Snapshot = window.hidegpt?.getSnapshot() ?? emptySnapshot()

function getSnapshot(): Snapshot {
  return snapshot
}

function subscribe(onChange: () => void): () => void {
  if (!window.hidegpt) return () => {}
  // Catch up on anything that arrived before React subscribed.
  snapshot = window.hidegpt.getSnapshot()
  return window.hidegpt.onSnapshot((patch) => {
    snapshot = applySnapshotPatch(snapshot, patch)
    onChange()
  })
}

export function useSnapshot(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// The last command from the window that failed. Main answers window commands
// with a result instead of putting it on the snapshot, so the bridge keeps it
// for the banner. Adapted from T3 Code's local thread error
// (apps/web/src/components/chat/usePendingThreadRequests.ts) at commit 8a14762c.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
let commandError: string | null = null
const errorListeners = new Set<() => void>()

function setCommandError(next: string | null): void {
  if (next === commandError) return
  commandError = next
  for (const listener of errorListeners) listener()
}

function subscribeError(onChange: () => void): () => void {
  errorListeners.add(onChange)
  return () => {
    errorListeners.delete(onChange)
  }
}

/** The failed command's message, until it is dismissed or a later command succeeds. */
export function useCommandError(): string | null {
  return useSyncExternalStore(
    subscribeError,
    () => commandError,
    () => commandError,
  )
}

export function clearCommandError(): void {
  setCommandError(null)
}

/**
 * Sends a command and settles with its result; it never rejects. Use it when
 * the caller shows the error itself (a dialog, an inline message).
 */
export async function request(command: Command): Promise<CommandResult> {
  if (!window.hidegpt) return { ok: false, error: 'Docs is not connected. Reload the window and try again.' }
  return window.hidegpt.dispatch(command).catch((cause: unknown) => ({ ok: false, error: errorMessage(cause) }))
}

/** Like `request`, but a failure also shows on the page's error banner. */
export async function dispatch(command: Command): Promise<CommandResult> {
  const result = await request(command)
  setCommandError(result.ok ? null : result.error)
  return result
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
