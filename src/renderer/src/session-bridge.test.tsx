/** @vitest-environment jsdom */

import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { HideGptApi, SequencedSnapshot, SnapshotPatch } from '../../shared/api'
import { emptySnapshot, type Snapshot } from '../../shared/model'
import { applySnapshotPatch, type SnapshotDiff } from '../../shared/snapshot-patch'
import { useBlocks, useShellSnapshot } from './session-bridge'

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
  const deliver = () => act(() => inFlight.splice(0).forEach((patch) => listeners.forEach((listener) => listener(patch))))
  return {
    listeners,
    send,
    deliver,
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
      const block = useBlocks()[0]
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
      const block = useBlocks()[0]
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
})
