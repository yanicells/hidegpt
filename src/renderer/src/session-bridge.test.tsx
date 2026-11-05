/** @vitest-environment jsdom */

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { HideGptApi, SnapshotPatch } from '../../shared/api'
import { emptySnapshot, type Snapshot } from '../../shared/model'
import { useBlocks, useShellSnapshot } from './session-bridge'

afterEach(cleanup)

function bridge(start: Snapshot) {
  const listeners = new Set<(patch: SnapshotPatch) => void>()
  window.hidegpt = {
    getSnapshot: () => start,
    onSnapshot: (handler: (patch: SnapshotPatch) => void) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  } as unknown as HideGptApi
  return {
    listeners,
    emit: (patch: SnapshotPatch) => act(() => listeners.forEach((listener) => listener(patch))),
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
})
