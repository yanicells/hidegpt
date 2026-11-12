/** @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useKeepPlace } from './useKeepPlace'

afterEach(cleanup)

function Page({ loading, onRestored }: { loading: boolean; onRestored: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useKeepPlace(scrollRef, loading, onRestored)
  return (
    <div ref={scrollRef} data-testid="root">
      <div className="doc-block" data-testid="row" />
    </div>
  )
}

/** jsdom has no layout: give the scroller a writable position and the row a box on screen. */
function layout() {
  const root = screen.getByTestId('root')
  Object.defineProperty(root, 'scrollTop', { value: 0, writable: true })
  const row = { top: 0, height: 60 }
  vi.spyOn(screen.getByTestId('row'), 'getBoundingClientRect').mockImplementation(
    () => ({ top: row.top, bottom: row.top + row.height }) as DOMRect,
  )
  return { root, row }
}

describe('useKeepPlace', () => {
  it('scrolls by however far the loaded rows push the first row, from where you are by then', () => {
    const onRestored = vi.fn()
    const { rerender } = render(<Page loading={false} onRestored={onRestored} />)
    const { root, row } = layout()
    root.scrollTop = 100
    row.top = 40
    rerender(<Page loading onRestored={onRestored} />)
    expect(root.style.overflowAnchor).toBe('none')

    // You scroll 30px while it loads, then 500px of turns arrive above the row,
    // which gains a 20px turn divider above its text.
    root.scrollTop = 130
    row.top = 40 - 30 + 500
    row.height = 60 + 20
    rerender(<Page loading={false} onRestored={onRestored} />)
    expect(root.scrollTop).toBe(650)
    expect(root.style.overflowAnchor).toBe('')
    expect(onRestored).toHaveBeenCalledTimes(1)
  })

  it('leaves the page where it is when nothing was added', () => {
    const onRestored = vi.fn()
    const { rerender } = render(<Page loading={false} onRestored={onRestored} />)
    const { root } = layout()
    root.scrollTop = 100
    rerender(<Page loading onRestored={onRestored} />)
    rerender(<Page loading={false} onRestored={onRestored} />)
    expect(root.scrollTop).toBe(100)
  })
})
