/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useFollowBottom } from './useFollowBottom'

// The browser calls these after layout; the tests call them by hand.
let laidOut = () => {}
let endVisible = (_visible: boolean) => {}
let resized: Element | null = null

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        laidOut = callback
      }
      observe(target: Element) {
        resized = target
      }
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
      <div ref={contentRef} data-testid="content">
        <div data-testid="inner" style={{ overflowY: 'auto' }} />
        <textarea data-testid="composer" />
      </div>
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

  it('watches the content for growth, not the page around it', () => {
    render(<Page askedId={null} />)
    expect(resized).toBe(screen.getByTestId('content'))
  })

  it('lets go on an upward wheel before that frame’s resize, and follows again back at the end', () => {
    const { rerender } = render(<Page askedId={null} />)
    const root = scroller()
    rerender(<Page askedId="q1" />)
    endVisible(true)
    laidOut()
    expect(root.scrollTop).toBe(1000)

    root.scrollTop = 900
    fireEvent.wheel(root, { deltaY: -40 })
    laidOut()
    expect(root.scrollTop).toBe(900)

    endVisible(false)
    endVisible(true)
    laidOut()
    expect(root.scrollTop).toBe(1000)
  })

  it('keeps following when the wheel or a key moves something else', () => {
    const { rerender } = render(<Page askedId={null} />)
    const root = scroller()
    rerender(<Page askedId="q1" />)
    endVisible(true)
    root.scrollTop = 900
    const inner = screen.getByTestId('inner')
    Object.defineProperty(inner, 'scrollTop', { value: 50 })
    fireEvent.wheel(inner, { deltaY: -40 })
    fireEvent.keyDown(screen.getByTestId('composer'), { key: 'ArrowUp' })
    laidOut()
    expect(root.scrollTop).toBe(1000)

    root.scrollTop = 900
    fireEvent.keyDown(document.body, { key: 'PageUp' })
    laidOut()
    expect(root.scrollTop).toBe(900)
  })

  it('lets go while the scrollbar is held, and follows again if it is let go at the end', () => {
    const { rerender } = render(<Page askedId={null} />)
    const root = scroller()
    rerender(<Page askedId="q1" />)
    endVisible(true)
    root.scrollTop = 900
    fireEvent.pointerDown(root)
    laidOut()
    expect(root.scrollTop).toBe(900)

    fireEvent.pointerUp(window)
    laidOut()
    expect(root.scrollTop).toBe(1000)
  })
})
