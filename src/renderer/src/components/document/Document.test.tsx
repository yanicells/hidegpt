/** @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HideGptApi, SnapshotPatch } from '../../../../shared/api'
import { emptySnapshot, type Block, type Snapshot } from '../../../../shared/model'
import { diffSnapshot } from '../../../../shared/snapshot-patch'
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
  vi.unstubAllGlobals()
})

function mount(blocks: Block[]) {
  const listeners = new Set<(patch: SnapshotPatch) => void>()
  const snap: Snapshot = { ...emptySnapshot(), route: { kind: 'doc', threadId: 'thr_1' }, blocks }
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

  // The tabs panel finds the canvas, its rows and the end of the flow by Document's markup.
  it('lets the tabs panel watch the canvas rows and the end of the flow', async () => {
    type Observer = { callback: IntersectionObserverCallback; root?: Element | Document | null; targets: Set<Element> }
    const observers: Observer[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private readonly self: Observer
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.self = { callback, root: options?.root, targets: new Set() }
          observers.push(this.self)
        }
        observe(target: Element) {
          this.self.targets.add(target)
        }
        unobserve(target: Element) {
          this.self.targets.delete(target)
        }
        disconnect() {}
      },
    )
    const first: Block = { kind: 'user', id: 'u1', text: 'First question' }
    const answer: Block = { kind: 'agent', id: 'a1', text: 'An answer.' }
    const update = mount([first, answer])
    const rows = await waitFor(() => {
      const found = observers.find((observer) => observer.targets.has(row('u1')!))
      expect(found).toBeDefined()
      return found!
    })
    expect(rows.root).toBe(screen.getByTestId('document'))
    expect(rows.targets.has(row('a1')!)).toBe(true)
    expect(observers.some((observer) => observer.targets.has(document.querySelector('.paper-end')!))).toBe(true)
    // A turn that lands later is observed as its row renders.
    update([first, answer, { kind: 'user', id: 'u2', text: 'Second question' }])
    await waitFor(() => expect(rows.targets.has(row('u2')!)).toBe(true))

    // Before any report the latest question is active; the line in the first row moves it there.
    expect(screen.getByTestId('outline-u2')).toHaveAttribute('aria-current', 'location')
    const record = {
      target: row('u1'),
      isIntersecting: true,
      boundingClientRect: { bottom: 150 },
      rootBounds: { bottom: 100 },
    }
    act(() => rows.callback([record] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver))
    expect(screen.getByTestId('outline-u1')).toHaveAttribute('aria-current', 'location')
  })
})
