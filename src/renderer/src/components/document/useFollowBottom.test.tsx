/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useFollowBottom } from './useFollowBottom'

// The browser calls these after layout; the tests call them by hand.
let laidOut = () => {}
let endVisible = (_visible: boolean) => {}
let resized: Element[] = []

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        laidOut = callback
      }
      observe(target: Element) {
        resized.push(target)
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
  resized = []
})

function Page({ askedId }: { askedId: string | null }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const { release } = useFollowBottom({ scrollRef, contentRef, endRef, askedId })
  return (
    <div ref={scrollRef} data-testid="root">
      <button data-testid="release" onClick={release} />
      <div ref={contentRef} data-testid="content">
        <div data-testid="inner" style={{ overflowY: 'auto' }} />
        <textarea data-testid="composer" />
      </div>
      <div ref={endRef} data-testid="end" style={{ lineHeight: '20px' }} />
      <div className="spark-wrap" data-testid="overlay" />
    </div>
  )
}

/** The document with a toolbar button outside its scroller. */
function Window({ askedId }: { askedId: string | null }) {
  return (
    <>
      <button data-testid="outside" />
      <Page askedId={askedId} />
    </>
  )
}

const WINDOW = 600

/**
 * jsdom has no layout: a 600px window over a page whose text ends at `text.end`
 * (in page coordinates, movable), on a sheet 2000px tall. Its floating pill
 * covers the bottom `overlay.height` px, none unless a test says. `scrollTo`
 * lands at once and records how it was asked to move.
 */
function scroller() {
  const root = screen.getByTestId('root')
  const end = screen.getByTestId('end')
  const text = { end: 500 }
  const overlay = { height: 0 }
  const moves: Array<ScrollBehavior | undefined> = []
  screen.getByTestId('overlay').getBoundingClientRect = () =>
    new DOMRect(0, WINDOW - overlay.height, 800, overlay.height)
  Object.defineProperty(root, 'scrollHeight', { value: 2000, writable: true })
  Object.defineProperty(root, 'clientHeight', { value: WINDOW })
  Object.defineProperty(root, 'scrollTop', { value: 0, writable: true })
  root.getBoundingClientRect = () => new DOMRect(0, 0, 800, WINDOW)
  end.getBoundingClientRect = () => new DOMRect(0, text.end - root.scrollTop, 800, 0)
  root.scrollTo = ((options: ScrollToOptions) => {
    root.scrollTop = options.top ?? root.scrollTop
    moves.push(options.behavior)
  }) as typeof root.scrollTo
  return { root, text, overlay, moves }
}

/** Moves the page as the browser would, sending the scroll event that follows. */
function scrollTo(root: HTMLElement, top: number) {
  root.scrollTop = top
  fireEvent.scroll(root)
}

/** Asks a question at the end of a fresh page, so it follows. */
function following() {
  const view = render(<Page askedId={null} />)
  const page = scroller()
  view.rerender(<Page askedId="q1" />)
  endVisible(true)
  return page
}

describe('useFollowBottom', () => {
  it('opens at the top, and after you ask scrolls only as the text passes the bottom, one line clear', () => {
    const { rerender } = render(<Page askedId={null} />)
    const { root, text, overlay, moves } = scroller()

    // Opening never scrolls, even when the end is on screen and the text grows.
    endVisible(true)
    text.end = 700
    laidOut()
    expect(root.scrollTop).toBe(0)

    // Asking with the end still in view keeps the typed line where it is.
    root.scrollTop = 200
    rerender(<Page askedId="q1" />)
    laidOut()
    expect(root.scrollTop).toBe(200)

    // Text passing the bottom scrolls by just enough to keep one line below it.
    text.end = 820
    laidOut()
    expect(root.scrollTop).toBe(240)
    expect(moves).toEqual(['smooth'])

    // The floating pill over the bottom counts as covered, so the last line stays clear of it.
    overlay.height = 40
    laidOut()
    expect(root.scrollTop).toBe(280)
  })

  it('never scrolls up to the end, so the blank rest of a short page stays put', () => {
    const { root, text, moves } = following()
    root.scrollTop = 400
    text.end = 450
    laidOut()
    expect(root.scrollTop).toBe(400)
    expect(moves).toEqual([])
  })

  it('jumps instead of gliding when reduced motion is asked for', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }))
    const { root, text, moves } = following()
    text.end = 700
    laidOut()
    expect(root.scrollTop).toBe(120)
    expect(moves).toEqual(['instant'])
  })

  it('keeps following when a long block carries the end out of the band before the scroll catches up', () => {
    const { root, text } = following()
    endVisible(false)
    text.end = 1200
    laidOut()
    expect(root.scrollTop).toBe(620)
  })

  it('follows once you scroll to the end of a document you opened', () => {
    render(<Page askedId="q1" />)
    const { root, text } = scroller()
    endVisible(true)
    text.end = 700
    laidOut()
    expect(root.scrollTop).toBe(0)

    fireEvent.scroll(root)
    laidOut()
    expect(root.scrollTop).toBe(120)
  })

  it('watches the content for growth and the scroller for a shorter window, not the page around it', () => {
    render(<Page askedId={null} />)
    expect(resized).toEqual([screen.getByTestId('content'), screen.getByTestId('root')])
  })

  it('lets go on an upward wheel before that frame’s resize, and follows again back at the end', () => {
    const { root, text } = following()
    root.scrollTop = 100
    fireEvent.wheel(root, { deltaY: -40 })
    text.end = 800
    laidOut()
    expect(root.scrollTop).toBe(100)

    endVisible(false)
    endVisible(true)
    laidOut()
    expect(root.scrollTop).toBe(220)
  })

  it('keeps following when the wheel or a key moves something else', () => {
    const { rerender } = render(<Window askedId={null} />)
    const { root, text } = scroller()
    rerender(<Window askedId="q1" />)
    endVisible(true)
    root.scrollTop = 100
    text.end = 800
    const inner = screen.getByTestId('inner')
    Object.defineProperty(inner, 'scrollTop', { value: 50 })
    fireEvent.wheel(inner, { deltaY: -40 })
    fireEvent.keyDown(screen.getByTestId('composer'), { key: 'ArrowUp' })
    laidOut()
    expect(root.scrollTop).toBe(220)

    // Shortcuts, and keys on a button outside the page, are not scrolling.
    root.scrollTop = 100
    fireEvent.keyDown(document.body, { key: 'ArrowUp', metaKey: true })
    fireEvent.keyDown(document.body, { key: 'PageUp', isComposing: true })
    fireEvent.keyDown(screen.getByTestId('outside'), { key: 'PageUp' })
    laidOut()
    expect(root.scrollTop).toBe(220)

    root.scrollTop = 100
    fireEvent.keyDown(document.body, { key: 'PageUp' })
    laidOut()
    expect(root.scrollTop).toBe(100)
  })

  it('lets go on a press on the scrollbar', () => {
    const { root, text } = following()
    root.scrollTop = 100
    fireEvent.pointerDown(root)
    text.end = 800
    laidOut()
    expect(root.scrollTop).toBe(100)
  })

  it('lets go on an upward scroll no input announced, such as dragging a selection', () => {
    const { root, text } = following()
    scrollTo(root, 300)
    scrollTo(root, 200)
    text.end = 900
    laidOut()
    expect(root.scrollTop).toBe(200)
  })

  it('keeps following when the page moves up only because the document got shorter', () => {
    const { root, text } = following()
    scrollTo(root, 300)
    Object.assign(root, { scrollHeight: 1800 })
    scrollTo(root, 200)
    text.end = 900
    laidOut()
    expect(root.scrollTop).toBe(320)
  })

  it('keeps your place after a move made on purpose before you ever scrolled', () => {
    render(<Page askedId={null} />)
    const { root, text } = scroller()
    // A short document: its end is on screen until "Load earlier" adds rows above.
    endVisible(true)
    fireEvent.click(screen.getByTestId('release'))
    scrollTo(root, 500)
    text.end = 1500
    laidOut()
    expect(root.scrollTop).toBe(500)
  })
})
