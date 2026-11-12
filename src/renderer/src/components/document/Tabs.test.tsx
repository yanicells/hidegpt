/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { outlineEntries } from './outline'
import { Tabs } from './Tabs'

// Each heading's top on screen, and the observer's callback: the browser calls it
// when a heading crosses the reading line, the tests call it by hand.
let tops: Record<string, number> = {}
let report = () => {}
const LINE = 100

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (records: Array<{ rootBounds: { bottom: number } }>) => void) {
        report = () => callback([{ rootBounds: { bottom: LINE } }])
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { top: tops[this.textContent ?? ''] ?? 0 } as DOMRect
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  tops = {}
})

const entries = outlineEntries([
  { kind: 'user', id: 'u1', text: 'Question' },
  { kind: 'agent', id: 'a1', text: '## Light\nText\n## Dark' },
])

function mount() {
  render(
    <div className="workspace">
      <Tabs entries={entries} onNew={() => {}} onJump={() => {}} />
      <div data-block="u1">Question</div>
      <div data-block="a1">
        <h2>Light</h2>
        <p>Text</p>
        <h2>Dark</h2>
      </div>
    </div>,
  )
}

const active = () => screen.getByRole('button', { current: 'location' }).textContent

describe('document tabs active item', () => {
  it('follows the section at the top of the canvas as you scroll', () => {
    mount()
    tops = { Question: 120, Light: 400, Dark: 900 }
    act(() => report())
    expect(active()).toBe('Question')
    tops = { Question: -400, Light: 60, Dark: 500 }
    act(() => report())
    expect(active()).toBe('Light')
    tops = { Question: -900, Light: -400, Dark: 20 }
    act(() => report())
    expect(active()).toBe('Dark')
  })

  it('keeps a clicked item active until you scroll', () => {
    mount()
    tops = { Question: -400, Light: 60, Dark: 500 }
    act(() => report())
    fireEvent.click(screen.getByTestId('outline-a1-1'))
    // The last section can't scroll to the top, so the line stays in the one before it.
    act(() => report())
    expect(active()).toBe('Dark')
    fireEvent.wheel(window)
    expect(active()).toBe('Light')
  })
})
