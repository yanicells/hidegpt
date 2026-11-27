// A wire-size budget for the patch main sends while an answer streams, pinned in a test
// so a regression fails locally, as T3 Code pins its transport payloads.
// Adapted from T3 Code's apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts
// at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest'

import { adopt, applyThreadEvent, initialState, showThread, toSnapshot, updateLibrary } from '../main/session/state'
import type { Block, DocSummary, SnapshotPatch } from './contracts'
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

/**
 * Main's session state with a 300-turn document open over a 500-document library and its
 * last answer streaming, built through the same functions the session manager calls.
 */
function longDocumentState() {
  const blocks: Block[] = []
  for (let turn = 0; turn < TURNS; turn += 1) {
    blocks.push({ kind: 'user', id: `u${turn}`, text: `Question ${turn}: explain the main idea in more detail` })
    blocks.push({ kind: 'agent', id: `a${turn}`, text: `Answer ${turn}. ${'lorem ipsum '.repeat(ANSWER_CHARS / 12)}` })
  }
  const docs: DocSummary[] = Array.from({ length: DOCS }, (_, index) => ({
    id: `doc-${index}`,
    name: `Document ${index}`,
    preview: 'The first lines of the document',
    updatedAt: 1_780_000_000 - index,
    cwd: '/projects/notes',
    projectId: null,
  }))
  const listed = updateLibrary(
    initialState('codex', () => '/projects/notes'),
    'codex',
    (lib) => ({
      ...lib,
      status: 'ready',
      docs,
    }),
  )
  const opened = adopt(
    listed,
    'codex',
    { threadId: 'doc-0', title: 'A long document', blocks, olderCursor: null, cwd: '/projects/notes', streaming: true },
    0,
  )
  return showThread(opened, 'codex', 'doc-0')
}

describe('snapshot patch wire budget', () => {
  it('sends one streamed delta of a 300-turn document in under 1 KB', () => {
    const state = longDocumentState()
    const before = toSnapshot(state)
    const streamed = applyThreadEvent(
      state,
      'codex',
      { type: 'text', threadId: 'doc-0', blockId: `a${TURNS - 1}`, delta: FRAME_TEXT },
      1,
    )
    const after = toSnapshot(streamed)
    const patch: SnapshotPatch = { ...diffSnapshot(before, after), seq: 12_345 }

    // The fixture is the long document the budget is about, and the event reached it.
    expect(encodedBytes(after)).toBeGreaterThan(500 * 1024)
    expect(after.blocks.at(-1)).toMatchObject({ kind: 'agent', text: expect.stringMatching(/ and then$/) })
    expect(encodedBytes(patch)).toBeLessThan(MAX_DELTA_JSON_BYTES)
  })
})
