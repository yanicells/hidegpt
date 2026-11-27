/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HideGptApi, MenuAction } from '../../../../shared/api'
import { CURRENT_HIGHLIGHT, MATCH_HIGHLIGHT } from './find'
import { FindBar } from './FindBar'
// Loaded up front, so the bar's lazy import resolves within one act.
import './FindCard'

import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

type Painted = { ranges: Range[] }

/** Renders the bar over a page of `html`; returns the menu-action sender and the highlight registry. */
function mount(html: string) {
  let send: (action: MenuAction) => void = () => undefined
  window.hidegpt = {
    onMenu: (handler: (action: MenuAction) => void) => {
      send = handler
      return () => undefined
    },
    platform: 'darwin',
  } as Partial<HideGptApi> as HideGptApi
  const registry = new Map<string, Painted>()
  vi.stubGlobal(
    'Highlight',
    class {
      ranges: Range[]
      priority = 0
      constructor(...ranges: Range[]) {
        this.ranges = ranges
      }
    },
  )
  vi.stubGlobal('CSS', { highlights: registry })
  const release = vi.fn()

  function Harness() {
    const flowRef = useRef<HTMLDivElement>(null)
    const scrollRef = useRef<HTMLDivElement>(null)
    return (
      <div ref={scrollRef}>
        <FindBar flowRef={flowRef} scrollRef={scrollRef} release={release} />
        <div ref={flowRef} data-testid="flow" dangerouslySetInnerHTML={{ __html: html }} />
        <textarea data-testid="composer" />
      </div>
    )
  }
  render(<Harness />)
  return { find: () => act(async () => send('find')), registry, release }
}

const current = (registry: Map<string, Painted>) => registry.get(CURRENT_HIGHLIGHT)?.ranges[0]?.toString()

describe('FindBar', () => {
  it('opens on the find menu action with the field focused, and Escape gives focus back', async () => {
    const { find } = mount('<p>text</p>')
    expect(screen.queryByTestId('find-bar')).not.toBeInTheDocument()
    screen.getByTestId('composer').focus()

    await find()
    expect(screen.getByTestId('find-input')).toHaveFocus()

    fireEvent.keyDown(screen.getByTestId('find-input'), { key: 'Escape' })
    expect(screen.queryByTestId('find-bar')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer')).toHaveFocus()
  })

  it('highlights every match, counts them, and steps with Enter and Shift+Enter', async () => {
    const { find, registry } = mount('<p>ATP and NADPH</p><p>more atp</p><p>atp again</p>')
    await find()
    const input = screen.getByTestId('find-input')
    fireEvent.change(input, { target: { value: 'atp' } })

    expect(screen.getByTestId('find-count')).toHaveTextContent('1 of 3')
    expect(registry.get(MATCH_HIGHLIGHT)?.ranges.map(String)).toEqual(['ATP', 'atp', 'atp'])
    expect(current(registry)).toBe('ATP')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('find-count')).toHaveTextContent('2 of 3')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByTestId('find-count')).toHaveTextContent('3 of 3')
    expect(registry.get(CURRENT_HIGHLIGHT)?.ranges[0]?.startContainer.textContent).toBe('atp again')

    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(screen.getByTestId('find-count')).toHaveTextContent('0 of 0')
    expect(registry.size).toBe(0)
  })

  it('counts again when the page changes, keeping the current match', async () => {
    vi.useFakeTimers()
    const { find } = mount('<p>one cell</p><p>two cells</p>')
    await find()
    fireEvent.change(screen.getByTestId('find-input'), { target: { value: 'cell' } })
    fireEvent.keyDown(screen.getByTestId('find-input'), { key: 'Enter' })
    expect(screen.getByTestId('find-count')).toHaveTextContent('2 of 2')

    // A streaming answer appends a paragraph.
    const more = document.createElement('p')
    more.textContent = 'three cells'
    screen.getByTestId('flow').append(more)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(screen.getByTestId('find-count')).toHaveTextContent('2 of 3')
  })

  it('clears the highlights when it closes', async () => {
    const { find, registry } = mount('<p>word</p>')
    await find()
    fireEvent.change(screen.getByTestId('find-input'), { target: { value: 'word' } })
    expect(registry.has(MATCH_HIGHLIGHT)).toBe(true)
    fireEvent.click(screen.getByTestId('find-close'))
    expect(registry.size).toBe(0)
  })
})
