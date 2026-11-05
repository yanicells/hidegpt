/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useFollowBottom } from './useFollowBottom'

// The browser calls these after layout; the tests call them by hand.
let laidOut = () => {}
let endVisible = (_visible: boolean) => {}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        laidOut = callback
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        endVisible = (visible) => callback([{ isIntersecting: visible }])
      }
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Page({ askedId }: { askedId: string | null }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  useFollowBottom({ scrollRef, contentRef, endRef, askedId })
  return (
    <div ref={scrollRef} data-testid="root">
      <div ref={contentRef} />
      <div ref={endRef} />
    </div>
  )
}

/** jsdom has no layout: give the scroller a height and a writable position. */
function scroller() {
  const root = screen.getByTestId('root')
  Object.defineProperty(root, 'scrollHeight', { value: 1000 })
  Object.defineProperty(root, 'scrollTop', { value: 0, writable: true })
  return root
}

describe('useFollowBottom', () => {
  it('opens at the top, follows once you ask, and lets go when you scroll up', () => {
    const { rerender } = render(<Page askedId={null} />)
    const root = scroller()

    // A short document's end is on screen, but opening it never scrolls.
    endVisible(true)
    laidOut()
    expect(root.scrollTop).toBe(0)

    rerender(<Page askedId="q1" />)
    laidOut()
    expect(root.scrollTop).toBe(1000)

    root.scrollTop = 200
    endVisible(false)
    laidOut()
    expect(root.scrollTop).toBe(200)

    endVisible(true)
    laidOut()
    expect(root.scrollTop).toBe(1000)
  })

  it('follows once you scroll to the end of a document you opened', () => {
    render(<Page askedId="q1" />)
    const root = scroller()
    endVisible(true)
    laidOut()
    expect(root.scrollTop).toBe(0)

    fireEvent.scroll(root)
    laidOut()
    expect(root.scrollTop).toBe(1000)
  })
})
