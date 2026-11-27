/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HideGptApi, SnapshotPatch } from '../../../../shared/api'
import { emptySnapshot, type ApprovalBlock, type Block, type Snapshot } from '../../../../shared/model'
import { diffSnapshot } from '../../../../shared/snapshot-patch'
import { isCrowded, placeCards } from './CommentsRail'
import { Document } from './Document'

import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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
  render(<Document snap={snap} onNew={() => undefined} />)
  let seq = 0
  return (next: Block[]) =>
    act(() => {
      seq += 1
      const patch = { ...diffSnapshot(snap, { ...snap, blocks: next }), seq }
      listeners.forEach((listener) => listener(patch))
    })
}

const approval = (over: Partial<ApprovalBlock> & Pick<ApprovalBlock, 'id' | 'suggestion'>): ApprovalBlock => ({
  kind: 'approval',
  title: '',
  body: '',
  fields: [],
  questions: [],
  resolved: null,
  ...over,
})

describe('CommentsRail', () => {
  it('puts a pending card beside the page, outside its zoom, and makes room only while one is pending', () => {
    const run = approval({ id: 'ap1', suggestion: 'add', title: 'Run command?', body: 'npm test' })
    const update = mount([run])
    const card = screen.getByTestId('approval-ap1')
    const workspace = screen.getByTestId('document')

    expect(card.closest('.comments-rail')).not.toBeNull()
    expect(card.closest('.paper')).toBeNull()
    // The page keeps the suggested text, with nothing narrowing its row.
    expect(document.querySelector('.paper .suggested')).toHaveTextContent('npm test')
    expect(workspace).toHaveClass('has-cards')

    update([{ ...run, resolved: 'accepted' }])
    expect(screen.queryByTestId('approval-ap1')).toBeNull()
    expect(document.querySelector('.comments-rail')).toBeNull()
    expect(workspace).not.toHaveClass('has-cards')
  })

  it('folds the tabs panel while a card is pending and the canvas is too narrow for the rail', () => {
    // 1470 at 100%: a 1400px canvas holds 21 + 280 + 816 + 296 = 1413px only without the panel.
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400)
    const run = approval({ id: 'ap1', suggestion: 'add', body: 'npm test' })
    const update = mount([run])
    const outline = screen.getByTestId('outline')
    expect(outline).toHaveClass('collapsed')
    update([{ ...run, resolved: 'accepted' }])
    expect(screen.getByTestId('outline')).not.toHaveClass('collapsed')
    cleanup()

    // 1680 at 100%: room for both.
    width.mockReturnValue(1610)
    mount([run])
    expect(screen.getByTestId('outline')).not.toHaveClass('collapsed')
  })

  it('folds the panel within the resize callback, before the next paint', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1610)
    const observers: Array<{ callback: () => void; targets: Element[] }> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        targets: Element[] = []
        callback: () => void
        constructor(callback: () => void) {
          this.callback = callback
          observers.push(this)
        }
        observe(target: Element) {
          this.targets.push(target)
        }
        unobserve() {}
        disconnect() {}
      },
    )
    mount([approval({ id: 'ap1', suggestion: 'add', body: 'npm test' })])
    const card = screen.getByTestId('approval-ap1')
    const rail = observers.find((observer) => observer.targets.includes(card))
    expect(rail).toBeDefined()

    // Outside act, as a real ResizeObserver runs: the fold must commit before the callback returns.
    const actEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)
    try {
      rail?.callback()
      expect(screen.getByTestId('outline')).not.toHaveClass('collapsed')
      width.mockReturnValue(1400)
      rail?.callback()
      expect(screen.getByTestId('outline')).toHaveClass('collapsed')
    } finally {
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment)
      vi.unstubAllGlobals()
    }
  })

  it('words each card in Docs’ fixed terms and never shows the request’s title', () => {
    mount([
      approval({ id: 'f', suggestion: 'format', title: 'Allow read: ~/notes?', body: 'Asking for extra access.' }),
      approval({ id: 'r', suggestion: 'replace', title: 'Edit files?', body: 'Updating the outline.' }),
      approval({ id: 'p', suggestion: 'add', title: 'Review the plan?', body: '1. Read the notes' }),
    ])

    expect(screen.getByTestId('approval-f')).toHaveTextContent(/Format: text$/)
    expect(screen.getByTestId('approval-r')).toHaveTextContent(/Replace: text$/)
    expect(screen.getByTestId('approval-p')).toHaveTextContent(/Review the plan\?$/)
    // Only a plan's fixed title shows; provider wording reaches neither card nor page.
    for (const text of ['Allow read', 'Asking for extra access', 'Edit files', 'Updating the outline']) {
      expect(screen.getByTestId('document')).not.toHaveTextContent(text)
    }
    // A plan, like any addition, is suggested text in the page.
    expect(document.querySelector('[data-block="p"] .suggested')).toHaveTextContent('1. Read the notes')
  })
})

describe('isCrowded', () => {
  function canvas(width: number, zoom?: string) {
    const workspace = document.createElement('div')
    if (zoom) workspace.style.setProperty('--page-zoom', zoom)
    Object.defineProperty(workspace, 'clientWidth', { value: width })
    return isCrowded(workspace)
  }

  it('needs 21 + 280 + 816 + 296 = 1413px at 100%', () => {
    expect(canvas(1412)).toBe(true)
    expect(canvas(1413)).toBe(false)
  })

  it('grows the page and the ruler with the zoom: 21 + 280 + 1020 + 4 + 296 = 1621px at 125%', () => {
    expect(canvas(1620, '1.25')).toBe(true)
    expect(canvas(1621, '1.25')).toBe(false)
  })
})

describe('placeCards', () => {
  /**
   * A rail at `railY` and a flow whose suggestion rows start at the given ys (in
   * the window); a row with no y isn't on the page yet. Returns each card's top.
   */
  function layout(rows: Array<{ id: string; y?: number; height: number }>, railY = 0) {
    const flow = document.createElement('div')
    const rail = document.createElement('div')
    rail.getBoundingClientRect = () => DOMRect.fromRect({ y: railY })
    for (const { id, y, height } of rows) {
      if (y !== undefined) {
        const block = flow.appendChild(document.createElement('div'))
        block.className = 'doc-block'
        block.dataset.block = id
        const row = block.appendChild(document.createElement('div'))
        row.className = 'suggestion-row'
        row.getBoundingClientRect = () => DOMRect.fromRect({ y })
      }
      const card = rail.appendChild(document.createElement('div'))
      card.dataset.anchor = id
      Object.defineProperty(card, 'offsetHeight', { value: height })
    }
    placeCards(rail, flow)
    return Array.from(rail.children as HTMLCollectionOf<HTMLElement>, (card) =>
      card.style.visibility === 'hidden' ? 'hidden' : card.style.top,
    )
  }

  it('puts each card level with its suggestion’s line, measured from the rail', () => {
    expect(layout([{ id: 'a', y: 90, height: 120 }], 50)).toEqual(['40px'])
  })

  it('hides a card whose line isn’t on the page yet, without leaving room for it', () => {
    expect(
      layout([
        { id: 'a', height: 120 },
        { id: 'b', y: 100, height: 80 },
      ]),
    ).toEqual(['hidden', '100px'])
  })

  it('shows a hidden card once its line reaches the page', () => {
    const flow = document.createElement('div')
    const rail = document.createElement('div')
    rail.getBoundingClientRect = () => DOMRect.fromRect({ y: 0 })
    const card = rail.appendChild(document.createElement('div'))
    card.dataset.anchor = 'a'
    placeCards(rail, flow)
    expect(card.style.visibility).toBe('hidden')

    const block = flow.appendChild(document.createElement('div'))
    block.className = 'doc-block'
    block.dataset.block = 'a'
    const row = block.appendChild(document.createElement('div'))
    row.className = 'suggestion-row'
    row.getBoundingClientRect = () => DOMRect.fromRect({ y: 300 })
    placeCards(rail, flow)
    expect(card.style.visibility).toBe('')
    expect(card.style.top).toBe('300px')
  })

  it('stacks cards 12px apart so two on one line never overlap', () => {
    expect(
      layout([
        { id: 'a', y: 100, height: 120 },
        { id: 'b', y: 100, height: 80 },
        // Far enough below the stack to keep its own line.
        { id: 'c', y: 500, height: 80 },
      ]),
    ).toEqual(['100px', '232px', '500px'])
  })
})
