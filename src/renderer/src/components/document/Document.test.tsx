/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HideGptApi, SnapshotPatch } from '../../../../shared/api'
import { emptySnapshot, type Block, type Snapshot } from '../../../../shared/model'
import { reportRenderError } from '../layout/RenderErrorBoundary'
import { Document } from './Document'

import '@testing-library/jest-dom/vitest'

// A block whose text is "boom" fails to render, the way bad Markdown might.
vi.mock('./BlockView', () => ({
  BlockView: ({ block }: { block: Block }) => {
    if (block.kind === 'agent' && block.text === 'boom') throw new Error('bad block')
    return <p>{block.kind === 'agent' || block.kind === 'user' ? block.text : block.id}</p>
  },
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mount(blocks: Block[]) {
  const listeners = new Set<(patch: SnapshotPatch) => void>()
  const snap: Snapshot = { ...emptySnapshot(), route: { kind: 'doc', threadId: 'thr_1' }, blocks }
  const api: Partial<HideGptApi> = {
    getSnapshot: () => snap,
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
  return (next: Block[]) => act(() => listeners.forEach((listener) => listener({ fields: { ...snap, blocks: next } })))
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
})
