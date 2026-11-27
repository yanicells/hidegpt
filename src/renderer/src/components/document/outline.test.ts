/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { HideGptApi, SnapshotPatch } from '../../../../shared/api'
import { emptySnapshot, type Block, type Snapshot } from '../../../../shared/model'
import { diffSnapshot } from '../../../../shared/snapshot-patch'
import { outlineEntries, sectionHeadings, useOutline } from './outline'

afterEach(cleanup)

/** A document open on a stand-in bridge; the returned function patches its blocks. */
function open(blocks: Block[]) {
  const listeners = new Set<(patch: SnapshotPatch) => void>()
  let snap: Snapshot = { ...emptySnapshot(), route: { kind: 'doc', threadId: 't' }, blocks }
  let seq = 0
  window.hidegpt = {
    getSnapshot: () => ({ snapshot: snap, seq }),
    onSnapshot: (listener: (patch: SnapshotPatch) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as HideGptApi
  return (next: Block[]) =>
    act(() => {
      const patch = { ...diffSnapshot(snap, { ...snap, blocks: next }), seq: (seq += 1) }
      snap = { ...snap, blocks: next }
      listeners.forEach((listener) => listener(patch))
    })
}

describe('document outline', () => {
  it('reads answer sections, skipping code fences and stripping markup', () => {
    const text = [
      '# **Light** reactions',
      '```md',
      '## not a heading',
      '```',
      'Body',
      '### The [Calvin](x) cycle #',
      '#### too deep',
    ].join('\n')
    expect(sectionHeadings(text)).toEqual(['Light reactions', 'The Calvin cycle'])
  })

  it('nests answer sections under their question', () => {
    const entries = outlineEntries([
      { kind: 'user', id: 'u1', text: 'How does photosynthesis work?' },
      { kind: 'agent', id: 'a1', text: '## Light reactions\nText\n## The Calvin cycle' },
    ])
    expect(entries.map((entry) => [entry.key, entry.level, entry.heading])).toEqual([
      ['u1', 1, undefined],
      ['a1-0', 2, 0],
      ['a1-1', 2, 1],
    ])
  })

  it('keeps its entries while text without a heading streams in, and follows the output-only view', () => {
    const question: Block = { kind: 'user', id: 'u1', text: 'How does photosynthesis work?' }
    const note: Block = { kind: 'agent', id: 'n1', text: '## Checking sources', commentary: true }
    const answer: Block = { kind: 'agent', id: 'a1', text: '## Light reactions\nText' }
    const update = open([question, note, answer])
    const { result, rerender } = renderHook(({ outputOnly }) => useOutline(outputOnly), {
      initialProps: { outputOnly: false },
    })
    const keys = () => result.current.map((entry) => entry.key)
    expect(keys()).toEqual(['u1', 'n1-0', 'a1-0'])

    const first = result.current
    update([question, note, { ...answer, text: `${answer.text} that streams on` }])
    expect(result.current).toBe(first)

    update([question, note, { ...answer, text: `${answer.text} that streams on\n## The Calvin cycle` }])
    expect(keys()).toEqual(['u1', 'n1-0', 'a1-0', 'a1-1'])

    // Toggling the view reads again, though no patch came.
    rerender({ outputOnly: true })
    expect(keys()).toEqual(['u1', 'a1-0', 'a1-1'])
  })
})
