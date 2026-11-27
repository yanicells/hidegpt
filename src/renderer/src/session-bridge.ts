import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import type { Command, CommandResult, MenuAction } from '../../shared/api'
import { errorMessage } from '../../shared/labels'
import { emptySnapshot, type Block, type Snapshot } from '../../shared/model'
import { applyPatchOnce, type SequencedSnapshot } from '../../shared/snapshot-patch'

let current: SequencedSnapshot = { snapshot: emptySnapshot(), seq: 0 }
const listeners = new Set<() => void>()
let detach: (() => void) | null = null

// The open document's blocks by id, and the rows listening to each one.
const blocksById = new Map<string, Block>()
const blockListeners = new Map<string, Set<() => void>>()

function setCurrent(next: SequencedSnapshot): string[] {
  const before = current.snapshot.blocks
  current = next
  return before === next.snapshot.blocks ? [] : reindexBlocks(next.snapshot.blocks)
}

/** Brings `blocksById` up to date and returns the ids whose block changed, was added or went away. */
function reindexBlocks(blocks: ReadonlyArray<Block>): string[] {
  const changed: string[] = []
  for (const block of blocks) {
    if (blocksById.get(block.id) === block) continue
    blocksById.set(block.id, block)
    changed.push(block.id)
  }
  if (blocksById.size > blocks.length) {
    const kept = new Set(blocks.map((block) => block.id))
    for (const id of blocksById.keys()) {
      if (kept.has(id)) continue
      blocksById.delete(id)
      changed.push(id)
    }
  }
  return changed
}

function publish(next: SequencedSnapshot): void {
  const changed = setCurrent(next)
  // Copies: a listener that subscribes another component must not run it this round.
  for (const listener of Array.from(listeners)) listener()
  for (const id of changed) {
    const heard = blockListeners.get(id)
    if (heard) for (const listener of Array.from(heard)) listener()
  }
}

/**
 * Takes the snapshot from the preload and applies every later patch here,
 * however many components subscribe. A reconnect (StrictMode remounting the
 * root, a test's fresh bridge) reads main again, which may already include
 * patches still on their way; `applyPatchOnce` skips those by `seq`, so no
 * streamed text lands twice.
 *
 * Electron delivers one webContents' IPC messages in the order main sent
 * them, so patches arrive with `seq` counting up by one. A jump means one was
 * lost; reading main again heals it, because main sent that patch before the
 * one that showed the jump, so the read already includes both.
 */
function connect(): void {
  if (detach || !window.hidegpt) return
  const bridge = window.hidegpt
  setCurrent(bridge.getSnapshot())
  detach = bridge.onSnapshot((patch) => {
    if (patch.seq > current.seq + 1) {
      publish(bridge.getSnapshot())
      return
    }
    const next = applyPatchOnce(current, patch)
    if (next !== current) publish(next)
  })
}

// At load, so the first paint is the real library and nothing is missed before React subscribes.
connect()

let subscribers = 0

/** Keeps the bridge connected while anything listens; `listen` adds one listener and returns its removal. */
function retain(listen: () => () => void): () => void {
  connect()
  subscribers += 1
  const unlisten = listen()
  return () => {
    unlisten()
    subscribers -= 1
    if (subscribers > 0) return
    detach?.()
    detach = null
  }
}

function subscribe(onChange: () => void): () => void {
  return retain(() => {
    listeners.add(onChange)
    return () => listeners.delete(onChange)
  })
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
  const last = useRef<{ source: Snapshot; select: (snapshot: Snapshot) => T; value: T } | null>(null)
  const getSelection = () => {
    const previous = last.current
    const snapshot = current.snapshot
    // A new `select` (a toggled view) reads again even when the snapshot has not moved.
    if (previous?.source === snapshot && previous.select === select) return previous.value
    const next = select(snapshot)
    const value = previous && isEqual(previous.value, next) ? previous.value : next
    last.current = { source: snapshot, select, value }
    return value
  }
  return useSyncExternalStore(subscribe, getSelection, getSelection)
}

const whole = (snap: Snapshot) => snap

/** Everything on the snapshot apart from the open document's blocks. */
function sameApartFromBlocks(a: Snapshot, b: Snapshot): boolean {
  for (const key of Object.keys(b) as (keyof Snapshot)[]) {
    if (key !== 'blocks' && a[key] !== b[key]) return false
  }
  return true
}

/**
 * The snapshot for the page shell. It skips changes that only touch the open
 * document's blocks, so its `blocks` can be behind: read them with
 * `useBlockRows` and `useBlock`.
 */
export function useShellSnapshot(): Snapshot {
  return useSnapshotSelector(whole, sameApartFromBlocks)
}

/** A block's place in the document: what decides which rows show, without its text. */
export type BlockRowInfo = {
  id: string
  kind: Block['kind']
  /** A progress note between tool calls. */
  commentary: boolean
}

const rowInfo = new WeakMap<Block, BlockRowInfo>()

function rowOf(block: Block): BlockRowInfo {
  let row = rowInfo.get(block)
  if (!row) {
    row = { id: block.id, kind: block.kind, commentary: block.kind === 'agent' && block.commentary === true }
    rowInfo.set(block, row)
  }
  return row
}

const rowsOf = (snap: Snapshot) => snap.blocks.map(rowOf)

function sameRows(a: ReadonlyArray<BlockRowInfo>, b: ReadonlyArray<BlockRowInfo>): boolean {
  return (
    a.length === b.length &&
    a.every(
      (row, index) => row.id === b[index].id && row.kind === b[index].kind && row.commentary === b[index].commentary,
    )
  )
}

/**
 * The open document's rows, in order. It keeps its identity while text streams
 * into a block, so the document re-renders when a block is added, removed or
 * changes kind; each row reads its own block with `useBlock`. Adapted from T3
 * Code's timeline items that hold while only streamed text moves, read with a
 * text atom per message (packages/client-runtime/src/state/threadDetail.ts) at
 * commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
export function useBlockRows(): ReadonlyArray<BlockRowInfo> {
  return useSnapshotSelector(rowsOf, sameRows)
}

/**
 * One block of the open document, by id. Only the rows whose block changed
 * hear a patch, so a streamed delta re-renders the block being written and
 * nothing else.
 */
export function useBlock(id: string): Block | undefined {
  const subscribeBlock = useCallback(
    (onChange: () => void) =>
      retain(() => {
        const heard = blockListeners.get(id) ?? new Set()
        blockListeners.set(id, heard)
        heard.add(onChange)
        return () => {
          heard.delete(onChange)
          if (heard.size === 0) blockListeners.delete(id)
        }
      }),
    [id],
  )
  const read = () => blocksById.get(id)
  return useSyncExternalStore(subscribeBlock, read, read)
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
