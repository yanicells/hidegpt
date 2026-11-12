import type { Block, Snapshot, SnapshotPatch } from './contracts'

/**
 * What crosses IPC instead of a whole Snapshot (the `SnapshotPatch` contract).
 * Main updates immutably, so a field whose reference is unchanged is skipped
 * and `blocks` only carries the entries that changed. A block that only grew
 * (the streaming answer) travels as its new text, so IPC scales with new
 * tokens, not with the answer size.
 */
export type { SnapshotPatch } from './contracts'

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
export const isEmptyPatch = (patch: SnapshotPatch): boolean =>
  patch.blocks === undefined && Object.keys(patch.fields).length === 0

export function diffSnapshot(previous: Snapshot | null, next: Snapshot): SnapshotPatch {
  if (!previous) return { fields: next }
  const fields: Record<string, unknown> = {}
  for (const key of Object.keys(next) as (keyof Snapshot)[]) {
    if (key !== 'blocks' && next[key] !== previous[key]) fields[key] = next[key]
  }
  const patch: { fields: Record<string, unknown>; blocks?: SnapshotPatch['blocks'] } = { fields }
  if (next.blocks !== previous.blocks) {
    const set: [number, Block][] = []
    const append: [number, string][] = []
    next.blocks.forEach((block, index) => {
      const before = previous.blocks[index]
      if (before === block) return
      const delta = grownBy(before, block)
      if (delta !== null) append.push([index, delta])
      else set.push([index, block])
    })
    patch.blocks = { length: next.blocks.length, ...(set.length ? { set } : {}), ...(append.length ? { append } : {}) }
  }
  return patch
}

/** Rebuilds the next Snapshot, reusing every unchanged block object. */
export function applySnapshotPatch(previous: Snapshot, patch: SnapshotPatch): Snapshot {
  const next = { ...previous, ...(patch.fields as Partial<Snapshot>) } as { -readonly [K in keyof Snapshot]: Snapshot[K] }
  if (patch.blocks) {
    const blocks = previous.blocks.slice(0, patch.blocks.length)
    for (const [index, block] of patch.blocks.set ?? []) blocks[index] = block
    for (const [index, delta] of patch.blocks.append ?? []) {
      const block = blocks[index]
      if (block?.kind === 'agent') blocks[index] = { ...block, text: block.text + delta }
      else if (block?.kind === 'callout') blocks[index] = { ...block, body: block.body + delta }
    }
    next.blocks = blocks
  }
  return next
}
