import { describe, expect, it } from 'vitest'

import type { Block } from '../codex/blocks'
import { emptySnapshot } from '../codex/types'
import { applySnapshotPatch, diffSnapshot } from './snapshot-patch'

const question: Block = { kind: 'user', id: 'u1', text: 'Why?' }
const answer = (text: string): Block => ({ kind: 'agent', id: 'a1', text })

describe('snapshot patches', () => {
  it('sends only changed fields and the streaming block', () => {
    const before = { ...emptySnapshot(), blocks: [question, answer('Be')], streaming: true }
    const after = { ...before, blocks: [question, answer('Because')] }
    const patch = diffSnapshot(before, after)
    expect(patch.fields).toEqual({})
    expect(patch.blocks).toEqual({ length: 2, changed: [[1, answer('Because')]] })

    const applied = applySnapshotPatch(before, patch)
    expect(applied.blocks[0]).toBe(question)
    expect(applied.threads).toBe(before.threads)
    expect(applied.blocks[1]).toEqual(answer('Because'))
  })

  it('truncates blocks when a document closes and sends everything first time', () => {
    const open = { ...emptySnapshot(), blocks: [question, answer('x')] }
    const home = { ...open, blocks: [], route: { kind: 'home' as const } }
    expect(applySnapshotPatch(open, diffSnapshot(open, home))).toEqual(home)
    expect(diffSnapshot(null, open)).toEqual({ fields: open })
  })
})
