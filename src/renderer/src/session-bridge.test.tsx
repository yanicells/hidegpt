/** @vitest-environment jsdom */

import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HideGptApi, SequencedSnapshot, SnapshotPatch } from '../../shared/api'
import { emptySnapshot, type Snapshot } from '../../shared/model'
import { applySnapshotPatch, type SnapshotDiff } from '../../shared/snapshot-patch'
import { subscribeBlock, useBlock, useBlockRows, useShellSnapshot } from './session-bridge'

afterEach(cleanup)

/**
 * A bridge that behaves like main: `send` numbers a patch and updates what a
 * read returns at once, while the page gets the patch only on `deliver`, as
 * with a patch still crossing IPC.
 */
function bridge(start: Snapshot) {
  const listeners = new Set<(patch: SnapshotPatch) => void>()
  let published: SequencedSnapshot = { snapshot: start, seq: 0 }
  const inFlight: SnapshotPatch[] = []
  window.hidegpt = {
    getSnapshot: () => published,
    onSnapshot: (handler: (patch: SnapshotPatch) => void) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  } as unknown as HideGptApi
  const send = (diff: SnapshotDiff) => {
    const patch = { ...diff, seq: published.seq + 1 }
    published = { snapshot: applySnapshotPatch(published.snapshot, patch), seq: patch.seq }
    inFlight.push(patch)
  }
  const deliver = () =>
    act(() => inFlight.splice(0).forEach((patch) => listeners.forEach((listener) => listener(patch))))
  return {
    listeners,
    send,
    deliver,
    /** Loses the oldest patch still on its way, as if IPC dropped it. */
    drop: () => void inFlight.shift(),
    emit: (diff: SnapshotDiff) => {
      send(diff)
      deliver()
    },
  }
}

describe('session bridge', () => {
  it('applies each patch once and re-renders only the parts it touched', () => {
    const { listeners, emit } = bridge({
      ...emptySnapshot(),
      route: { kind: 'doc', threadId: 't' },
      blocks: [{ kind: 'agent', id: 'a', text: 'Hello' }],
    })
    const renders = { shell: 0, blocks: 0 }
    let text = ''
    function Shell() {
      renders.shell += 1
      useShellSnapshot()
      return null
    }
    function Blocks() {
      renders.blocks += 1
      const block = useBlock('a')
      text = block?.kind === 'agent' ? block.text : ''
      return null
    }
    render(
      <>
        <Shell />
        <Blocks />
      </>,
    )
    expect(listeners.size).toBe(1)
    const before = { ...renders }

    emit({ fields: {}, blocks: { length: 1, append: [[0, ', world']] } })
    expect(text).toBe('Hello, world')
    expect(renders.shell).toBe(before.shell)
    expect(renders.blocks).toBe(before.blocks + 1)

    emit({ fields: { streaming: true } })
    expect(renders.shell).toBe(before.shell + 1)
    expect(renders.blocks).toBe(before.blocks + 1)

    cleanup()
    expect(listeners.size).toBe(0)
  })

  it('applies a patch that was on its way during a StrictMode remount only once', () => {
    const { send, deliver } = bridge({
      ...emptySnapshot(),
      route: { kind: 'doc', threadId: 't' },
      blocks: [{ kind: 'agent', id: 'a', text: 'Hel' }],
    })
    // Main has sent the rest of the word; the page reconnects before it arrives.
    send({ fields: {}, blocks: { length: 1, append: [[0, 'lo']] } })
    let text = ''
    function Blocks() {
      const block = useBlock('a')
      text = block?.kind === 'agent' ? block.text : ''
      return null
    }
    render(
      <StrictMode>
        <Blocks />
      </StrictMode>,
    )
    deliver()
    expect(text).toBe('Hello')

    send({ fields: {}, blocks: { length: 1, append: [[0, ', world']] } })
    deliver()
    expect(text).toBe('Hello, world')
  })

  it('reads main again when a patch number is skipped', () => {
    const { send, drop, deliver } = bridge({
      ...emptySnapshot(),
      route: { kind: 'doc', threadId: 't' },
      blocks: [{ kind: 'agent', id: 'a', text: 'Hel' }],
    })
    let text = ''
    function Blocks() {
      const block = useBlock('a')
      text = block?.kind === 'agent' ? block.text : ''
      return null
    }
    render(<Blocks />)
    send({ fields: {}, blocks: { length: 1, append: [[0, 'lo']] } })
    send({ fields: {}, blocks: { length: 1, append: [[0, ', world']] } })
    // Patch 1 never arrives; patch 2 shows the gap, and the reread includes both.
    drop()
    deliver()
    expect(text).toBe('Hello, world')
  })

  it('tells only the rows whose block changed, and keeps the row list while text streams', () => {
    const { emit } = bridge({
      ...emptySnapshot(),
      route: { kind: 'doc', threadId: 't' },
      blocks: [
        { kind: 'user', id: 'q', text: 'Why?' },
        { kind: 'agent', id: 'a', text: 'Because' },
      ],
    })
    const renders: Record<string, number> = { rows: 0, q: 0, a: 0, b: 0 }
    const seen: Record<string, string | undefined> = {}
    let rows: ReturnType<typeof useBlockRows> = []
    function Rows() {
      renders.rows += 1
      rows = useBlockRows()
      return null
    }
    function Row({ id }: { id: string }) {
      renders[id] += 1
      const block = useBlock(id)
      seen[id] = block?.kind === 'agent' || block?.kind === 'user' ? block.text : undefined
      return null
    }
    render(
      <>
        <Rows />
        <Row id="q" />
        <Row id="a" />
        <Row id="b" />
      </>,
    )
    const before = { ...renders }
    const firstRows = rows

    emit({ fields: {}, blocks: { length: 2, append: [[1, ' light scatters.']] } })
    expect(seen.a).toBe('Because light scatters.')
    expect(renders).toEqual({ ...before, a: before.a + 1 })
    expect(rows).toBe(firstRows)

    // A new block changes the rows; the rows already there stay put.
    emit({ fields: {}, blocks: { length: 3, set: [[2, { kind: 'agent', id: 'b', text: 'More', commentary: true }]] } })
    expect(seen.b).toBe('More')
    expect(renders).toEqual({ ...before, rows: before.rows + 1, a: before.a + 1, b: before.b + 1 })
    expect(rows.map((row) => [row.id, row.kind, row.commentary])).toEqual([
      ['q', 'user', false],
      ['a', 'agent', false],
      ['b', 'agent', true],
    ])

    // A block that goes away reads as missing.
    emit({ fields: {}, blocks: { length: 1 } })
    expect(seen.a).toBeUndefined()
    expect(seen.b).toBeUndefined()
    expect(seen.q).toBe('Why?')
    expect(renders.q).toBe(before.q)
  })

  it('calls only the listeners of the blocks a patch changed, added or removed', () => {
    const { emit } = bridge({
      ...emptySnapshot(),
      route: { kind: 'doc', threadId: 't' },
      blocks: [
        { kind: 'user', id: 'q', text: 'Why?' },
        { kind: 'agent', id: 'a', text: 'Because' },
      ],
    })
    const heard = { q: vi.fn(), a: vi.fn(), b: vi.fn(), x: vi.fn() }
    const unsubscribe = Object.entries(heard).map(([id, listener]) => subscribeBlock(id, listener))
    const calls = () =>
      Object.fromEntries(Object.entries(heard).map(([id, listener]) => [id, listener.mock.calls.length]))

    emit({ fields: {}, blocks: { length: 2, append: [[1, ' light scatters.']] } })
    expect(calls()).toEqual({ q: 0, a: 1, b: 0, x: 0 })

    emit({ fields: {}, blocks: { length: 3, set: [[2, { kind: 'agent', id: 'b', text: 'More' }]] } })
    expect(calls()).toEqual({ q: 0, a: 1, b: 1, x: 0 })

    // Another session: every id goes away and new ones arrive.
    emit({
      fields: { route: { kind: 'doc', threadId: 'u' } },
      blocks: { length: 1, set: [[0, { kind: 'user', id: 'x', text: 'Hi' }]] },
    })
    expect(calls()).toEqual({ q: 1, a: 2, b: 2, x: 1 })

    unsubscribe.forEach((stop) => stop())
  })

  it('replaces the rows when the session changes, and follows a block that changes kind under its id', () => {
    const { emit } = bridge({
      ...emptySnapshot(),
      route: { kind: 'doc', threadId: 't' },
      blocks: [
        { kind: 'user', id: 'q', text: 'Why?' },
        { kind: 'agent', id: 'a', text: 'Because' },
      ],
    })
    let rows: ReturnType<typeof useBlockRows> = []
    const seen: Record<string, string | undefined> = {}
    function Rows() {
      rows = useBlockRows()
      return null
    }
    function Row({ id }: { id: string }) {
      const block = useBlock(id)
      seen[id] = block?.kind
      return null
    }
    render(
      <>
        <Rows />
        <Row id="a" />
        <Row id="x" />
      </>,
    )
    const ofRows = () => rows.map((row) => [row.id, row.kind, row.commentary])

    // The same id, now a progress note, then a callout.
    emit({
      fields: {},
      blocks: { length: 2, set: [[1, { kind: 'agent', id: 'a', text: 'Checking', commentary: true }]] },
    })
    expect(ofRows()).toEqual([
      ['q', 'user', false],
      ['a', 'agent', true],
    ])
    emit({ fields: {}, blocks: { length: 2, set: [[1, { kind: 'callout', id: 'a', title: 'Note', body: 'Read' }]] } })
    expect(ofRows()).toEqual([
      ['q', 'user', false],
      ['a', 'callout', false],
    ])
    expect(seen.a).toBe('callout')

    emit({
      fields: { route: { kind: 'doc', threadId: 'u' } },
      blocks: {
        length: 2,
        set: [
          [0, { kind: 'user', id: 'x', text: 'Hi' }],
          [1, { kind: 'agent', id: 'y', text: 'Hello' }],
        ],
      },
    })
    expect(ofRows()).toEqual([
      ['x', 'user', false],
      ['y', 'agent', false],
    ])
    expect(seen).toEqual({ a: undefined, x: 'user' })
  })
})
