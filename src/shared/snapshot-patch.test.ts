import { describe, expect, it } from 'vitest'

import { emptySnapshot, type Block } from './model'
import { applySnapshotPatch, diffSnapshot, isEmptyPatch } from './snapshot-patch'

const question: Block = { kind: 'user', id: 'u1', text: 'Why?' }
const answer = (text: string): Block => ({ kind: 'agent', id: 'a1', text })

describe('snapshot patches', () => {
  it('sends a growing answer as its new text only', () => {
    const before = { ...emptySnapshot(), blocks: [question, answer('Be')], streaming: true }
    const after = { ...before, blocks: [question, answer('Because')] }
    const patch = diffSnapshot(before, after)
    expect(patch.fields).toEqual({})
    expect(patch.blocks).toEqual({ length: 2, append: [[1, 'cause']] })

    const applied = applySnapshotPatch(before, patch)
    expect(applied.blocks[0]).toBe(question)
    expect(applied.threads).toBe(before.threads)
    expect(applied.blocks[1]).toEqual(answer('Because'))
  })

  it('replaces a block whose text was rewritten', () => {
    const before = { ...emptySnapshot(), blocks: [answer('Draft')] }
    const after = { ...before, blocks: [answer('Final')] }
    expect(diffSnapshot(before, after).blocks).toEqual({ length: 1, set: [[0, answer('Final')]] })
  })

  it('truncates blocks when a document closes and sends everything first time', () => {
    const open = { ...emptySnapshot(), blocks: [question, answer('x')] }
    const home = { ...open, blocks: [], route: { kind: 'home' as const } }
    expect(applySnapshotPatch(open, diffSnapshot(open, home))).toEqual(home)
    const first = diffSnapshot(null, open)
    expect(first.blocks).toEqual({ length: 2, set: [[0, question], [1, answer('x')]] })
    expect(applySnapshotPatch(emptySnapshot('/elsewhere'), first)).toEqual(open)
  })

  it('reports an unchanged snapshot as an empty patch', () => {
    const snap = emptySnapshot()
    expect(isEmptyPatch(diffSnapshot(snap, { ...snap }))).toBe(true)
  })
})
