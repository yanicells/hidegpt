/** @vitest-environment jsdom */

// First, so its hook is in place when react-dom loads.
import { startCounting, stopCounting } from '../../test/renderCounter'

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HideGptApi, SnapshotPatch } from '../../../../shared/api'
import { emptySnapshot, type Block, type Snapshot } from '../../../../shared/model'
import { diffSnapshot } from '../../../../shared/snapshot-patch'
import { reportRenderError } from '../layout/RenderErrorBoundary'
import { Document } from './Document'

import '@testing-library/jest-dom/vitest'

// The ids of the blocks rendered, in order.
const rendered = vi.hoisted((): string[] => [])

// A block whose text is "boom" fails to render, the way bad Markdown might.
vi.mock('./BlockView', () => ({
  BlockView: ({ block }: { block: Block }) => {
    rendered.push(block.id)
    if (block.kind === 'agent' && block.text === 'boom') throw new Error('bad block')
    return <p>{block.kind === 'agent' || block.kind === 'user' ? block.text : block.id}</p>
  },
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mount(blocks: Block[], fields: Partial<Snapshot> = {}) {
  const listeners = new Set<(patch: SnapshotPatch) => void>()
  const snap: Snapshot = { ...emptySnapshot(), route: { kind: 'doc', threadId: 'thr_1' }, ...fields, blocks }
  const api: Partial<HideGptApi> = {
    getSnapshot: () => ({ snapshot: snap, seq: 0 }),
    onSnapshot: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onMenu: () => () => undefined,
    dispatch: async () => ({ ok: true }),
    platform: 'darwin',
  }
  window.hidegpt = api as HideGptApi
  // The same root option main.tsx uses.
  render(<Document snap={snap} onNew={() => undefined} />, { onCaughtError: reportRenderError })
  let seq = 0
  return (next: Block[]) =>
    act(() => {
      seq += 1
      const patch = { ...diffSnapshot(snap, { ...snap, blocks: next }), seq }
      listeners.forEach((listener) => listener(patch))
    })
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-block="${id}"]`)

describe('Document', () => {
  it('shows a placeholder for a block that fails to render and keeps the rest of the page', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const question: Block = { kind: 'user', id: 'u1', text: 'Why is the sky blue?' }
    const broken: Block = { kind: 'agent', id: 'a1', text: 'boom' }
    const after: Block = { kind: 'agent', id: 'a2', text: 'Rayleigh scattering.' }
    const update = mount([question, broken, after])

    expect(row('u1')).toHaveTextContent('Why is the sky blue?')
    expect(row('a2')).toHaveTextContent('Rayleigh scattering.')
    const placeholder = screen.getByTestId('block-error')
    expect(placeholder).toHaveTextContent("This part of the document couldn't be displayed.")
    // The row stays on the page, so the outline can still jump to it.
    expect(row('a1')).toContainElement(placeholder)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    // One capped line, by name and message only: no stack, never the block's text.
    expect(logged.mock.calls).toEqual([['render error', 'Error', 'bad block']])

    // A new version of the block renders again.
    update([question, { ...broken, text: 'Light scatters.' }, after])
    expect(screen.queryByTestId('block-error')).not.toBeInTheDocument()
    expect(row('a1')).toHaveTextContent('Light scatters.')
  })

  it('renders only the row being written when text streams in', () => {
    const question: Block = { kind: 'user', id: 'u1', text: 'Why is the sky blue?' }
    const answer: Block = { kind: 'agent', id: 'a1', text: 'Rayleigh scattering.' }
    const followUp: Block = { kind: 'user', id: 'u2', text: 'And sunsets?' }
    const streaming: Block = { kind: 'agent', id: 'a2', text: 'Longer paths' }
    const update = mount([question, answer, followUp, streaming], { streaming: true })

    rendered.length = 0
    startCounting()
    update([question, answer, followUp, { ...streaming, text: 'Longer paths scatter the blue' }])
    const delta = stopCounting()
    expect(delta).toEqual({ commits: 1, components: { BlockRow: 1, RenderErrorBoundary: 1, BlockView: 1 } })
    expect(rendered).toEqual(['a2'])
    expect(row('a2')).toHaveTextContent('Longer paths scatter the blue')

    // A new heading renders the outline panel too, and still not the document.
    startCounting()
    update([question, answer, followUp, { ...streaming, text: 'Longer paths\n## Red light' }])
    const heading = stopCounting()
    expect(heading.components.Tabs).toBeGreaterThan(0)
    expect(heading.components.Document).toBeUndefined()
    expect(screen.getByTestId('outline-a2-0')).toHaveTextContent('Red light')
  })
})
