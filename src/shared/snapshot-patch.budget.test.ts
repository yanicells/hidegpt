// A wire-size budget for the patch main sends while an answer streams, pinned in a test
// so a regression fails locally, as T3 Code pins its transport payloads.
// Adapted from T3 Code's apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts
// at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest'

import type { Block, DocSummary, Snapshot, SnapshotPatch } from './contracts'
import { emptySnapshot } from './model'
import { diffSnapshot } from './snapshot-patch'

const TURNS = 300
const DOCS = 500
const ANSWER_CHARS = 2_000
/** What one streamed delta may cost on the wire, however long the document is. */
const MAX_DELTA_JSON_BYTES = 1_024
/** About one frame of streamed text (the bench streams 8 characters every 5 ms). */
const FRAME_TEXT = ' and then'.repeat(4)

/** Bytes of the patch as JSON: what the bench's `ipc_kb` counts for one message. */
const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** A 300-turn document open over a 500-document library, its last answer still streaming. */
function longDocument(): Snapshot {
  const blocks: Block[] = []
  for (let turn = 0; turn < TURNS; turn += 1) {
    blocks.push({ kind: 'user', id: `u${turn}`, text: `Question ${turn}: explain the main idea in more detail` })
    blocks.push({ kind: 'agent', id: `a${turn}`, text: `Answer ${turn}. ${'lorem ipsum '.repeat(ANSWER_CHARS / 12)}` })
  }
  const threads: DocSummary[] = Array.from({ length: DOCS }, (_, index) => ({
    id: `doc-${index}`,
    name: `Document ${index}`,
    preview: 'The first lines of the document',
    updatedAt: 1_780_000_000 - index,
    cwd: '/projects/notes',
    projectId: null,
  }))
  return {
    ...emptySnapshot('/projects/notes'),
    status: 'ready',
    threads,
    route: { kind: 'doc', threadId: 'doc-0' },
    title: 'A long document',
    blocks,
    streaming: true,
  }
}

/** The same document with `text` streamed onto its last answer, as main builds it: a new block, the rest shared. */
function streamed(snapshot: Snapshot, text: string): Snapshot {
  const blocks = [...snapshot.blocks]
  const last = blocks.at(-1)
  if (last?.kind !== 'agent') throw new Error('the last block is not an answer')
  blocks[blocks.length - 1] = { ...last, text: last.text + text }
  return { ...snapshot, blocks }
}

describe('snapshot patch wire budget', () => {
  it('sends one streamed delta of a 300-turn document in under 1 KB', () => {
    const before = longDocument()
    const after = streamed(before, FRAME_TEXT)
    const patch: SnapshotPatch = { ...diffSnapshot(before, after), seq: 12_345 }

    const deltaBytes = encodedBytes(patch)
    const documentBytes = encodedBytes(after)

    // The fixture is the long document the budget is about, not a small one.
    expect(documentBytes).toBeGreaterThan(500 * 1024)
    expect(deltaBytes).toBeLessThan(MAX_DELTA_JSON_BYTES)
  })
})
