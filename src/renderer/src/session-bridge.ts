import { useEffect, useRef, useSyncExternalStore } from 'react'

import type { Command, CommandResult, MenuAction } from '../../shared/api'
import { errorMessage } from '../../shared/labels'
import { emptySnapshot, type Block, type Snapshot } from '../../shared/model'
import { applyPatchOnce, type SequencedSnapshot } from '../../shared/snapshot-patch'

let current: SequencedSnapshot = { snapshot: emptySnapshot(), seq: 0 }
let snapshot: Snapshot = current.snapshot
const listeners = new Set<() => void>()
let detach: (() => void) | null = null

/**
 * Takes the snapshot from the preload and applies every later patch here,
 * however many components subscribe. A reconnect (StrictMode remounting the
 * root, a test's fresh bridge) reads main again, which may already include
 * patches still on their way; `applyPatchOnce` skips those by `seq`, so no
 * streamed text lands twice.
 */
function connect(): void {
  if (detach || !window.hidegpt) return
  current = window.hidegpt.getSnapshot()
  snapshot = current.snapshot
  detach = window.hidegpt.onSnapshot((patch) => {
    const next = applyPatchOnce(current, patch)
    if (next === current) return
    current = next
    snapshot = next.snapshot
    // A copy: a listener that subscribes another component must not run it this round.
    for (const listener of Array.from(listeners)) listener()
  })
}

// At load, so the first paint is the real library and nothing is missed before React subscribes.
connect()

function subscribe(onChange: () => void): () => void {
  connect()
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
    if (listeners.size > 0) return
    detach?.()
    detach = null
  }
}

/**
 * Subscribes to part of the snapshot. The component re-renders only when the
 * selection changes by `isEqual`, so a streamed delta repaints the document
 * without the chrome. Adapted from T3 Code's thread-detail atoms
 * (packages/client-runtime/src/state/threadDetail.ts) at commit 8a14762c.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
export function useSnapshotSelector<T>(
  select: (snapshot: Snapshot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const last = useRef<{ source: Snapshot; value: T } | null>(null)
  const getSelection = () => {
    const previous = last.current
    if (previous?.source === snapshot) return previous.value
    const next = select(snapshot)
    const value = previous && isEqual(previous.value, next) ? previous.value : next
    last.current = { source: snapshot, value }
    return value
  }
  return useSyncExternalStore(subscribe, getSelection, getSelection)
}

const whole = (current: Snapshot) => current
const blocksOf = (current: Snapshot) => current.blocks

/** Everything on the snapshot apart from the open document's blocks. */
function sameApartFromBlocks(a: Snapshot, b: Snapshot): boolean {
  for (const key of Object.keys(b) as (keyof Snapshot)[]) {
    if (key !== 'blocks' && a[key] !== b[key]) return false
  }
  return true
}

/**
 * The snapshot for the page shell. It skips changes that only touch the open
 * document's blocks, so its `blocks` can be behind: read them with `useBlocks`.
 */
export function useShellSnapshot(): Snapshot {
  return useSnapshotSelector(whole, sameApartFromBlocks)
}

/** The open document's blocks; unchanged blocks keep their identity across patches. */
export function useBlocks(): ReadonlyArray<Block> {
  return useSnapshotSelector(blocksOf)
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

/** Puts a failed window request that is not a command (a pasted image) on the same banner. */
export function showRequestError(message: string): void {
  setCommandError(message)
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
