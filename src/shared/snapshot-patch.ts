import type { Block } from '../codex/blocks'
import type { Snapshot } from '../codex/types'

/**
 * What crosses IPC instead of a whole Snapshot. Sessions update immutably, so
 * a field whose reference is unchanged is skipped, and `blocks` only carries
 * the entries that changed. During streaming that is one block, not the
 * whole thread list plus every paragraph of the document.
 */
export type SnapshotPatch = {
  fields: Partial<Snapshot>
  blocks?: { length: number; changed: [number, Block][] }
}

export function diffSnapshot(previous: Snapshot | null, next: Snapshot): SnapshotPatch {
  if (!previous) return { fields: next }
  const fields: Partial<Record<keyof Snapshot, unknown>> = {}
  for (const key of Object.keys(next) as (keyof Snapshot)[]) {
    if (key !== 'blocks' && next[key] !== previous[key]) fields[key] = next[key]
  }
  const patch: SnapshotPatch = { fields: fields as Partial<Snapshot> }
  if (next.blocks !== previous.blocks) {
    const changed: [number, Block][] = []
    next.blocks.forEach((block, index) => {
      if (previous.blocks[index] !== block) changed.push([index, block])
    })
    patch.blocks = { length: next.blocks.length, changed }
  }
  return patch
}

/** Rebuilds the next Snapshot, reusing every unchanged block object. */
export function applySnapshotPatch(previous: Snapshot, patch: SnapshotPatch): Snapshot {
  const next = { ...previous, ...patch.fields }
  if (patch.blocks) {
    const blocks = previous.blocks.slice(0, patch.blocks.length)
    for (const [index, block] of patch.blocks.changed) blocks[index] = block
    next.blocks = blocks
  }
  return next
}
