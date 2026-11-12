import type { Block, SequencedSnapshot, Snapshot, SnapshotDiff, SnapshotFields, SnapshotPatch } from './contracts'

/**
 * What crosses IPC instead of a whole Snapshot (the `SnapshotPatch` contract).
 * Main updates immutably, so a field whose reference is unchanged is skipped
 * and `blocks` only carries the entries that changed. A block that only grew
 * (the streaming answer) travels as its new text, so IPC scales with new
 * tokens, not with the answer size.
 */
export type { SequencedSnapshot, SnapshotDiff, SnapshotPatch } from './contracts'

function grownBy(previous: Block | undefined, next: Block): string | null {
  if (!previous || previous.id !== next.id || previous.kind !== next.kind) return null
  if (previous.kind === 'agent' && next.kind === 'agent') {
    if (previous.commentary !== next.commentary || !next.text.startsWith(previous.text)) return null
    return next.text.slice(previous.text.length)
  }
  if (previous.kind === 'callout' && next.kind === 'callout') {
    if (previous.title !== next.title || !next.body.startsWith(previous.body)) return null
    return next.body.slice(previous.body.length)
  }
  return null
}

/** True when the patch changes nothing (so it need not cross IPC). */
export const isEmptyPatch = (patch: SnapshotDiff): boolean =>
  patch.blocks === undefined && Object.keys(patch.fields).length === 0

export function diffSnapshot(previous: Snapshot | null, next: Snapshot): SnapshotDiff {
  const { blocks, ...shell } = next
  if (!previous) {
    return { fields: shell, blocks: { length: blocks.length, set: blocks.map((block, index) => [index, block]) } }
  }
  const { blocks: before, ...previousShell } = previous
  const patch: { fields: SnapshotFields; blocks?: SnapshotDiff['blocks'] } = { fields: changed(previousShell, shell) }
  if (blocks !== before) {
    const set: [number, Block][] = []
    const append: [number, string][] = []
    blocks.forEach((block, index) => {
      const prior = before[index]
      if (prior === block) return
      const delta = grownBy(prior, block)
      if (delta !== null) append.push([index, delta])
      else set.push([index, block])
    })
    patch.blocks = { length: blocks.length, ...(set.length ? { set } : {}), ...(append.length ? { append } : {}) }
  }
  return patch
}

/** The values of `next` whose reference differs from `previous`. */
function changed<T extends object>(previous: T, next: T): Partial<T> {
  const fields: Partial<T> = {}
  for (const key in next) {
    if (next[key] !== previous[key]) fields[key] = next[key]
  }
  return fields
}

/** Rebuilds the next Snapshot, reusing every unchanged block object. */
export function applySnapshotPatch(previous: Snapshot, patch: SnapshotDiff): Snapshot {
  const next: Snapshot = { ...previous, ...patch.fields }
  if (!patch.blocks) return next
  const blocks = previous.blocks.slice(0, patch.blocks.length)
  for (const [index, block] of patch.blocks.set ?? []) blocks[index] = block
  for (const [index, delta] of patch.blocks.append ?? []) {
    const block = blocks[index]
    if (block?.kind === 'agent') blocks[index] = { ...block, text: block.text + delta }
    else if (block?.kind === 'callout') blocks[index] = { ...block, body: block.body + delta }
  }
  return { ...next, blocks }
}

/**
 * Applies a patch unless `current` already includes it (its `seq` is at or
 * below `current.seq`), so a snapshot read from main while patches are still
 * on their way never gets the same streamed text twice.
 * Adapted from T3 Code's guest stream sequence check
 * (apps/web/src/components/guest/guestStream.logic.ts) at commit 5c6f2f12.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
export function applyPatchOnce(current: SequencedSnapshot, patch: SnapshotPatch): SequencedSnapshot {
  if (patch.seq <= current.seq) return current
  return { snapshot: applySnapshotPatch(current.snapshot, patch), seq: patch.seq }
}
