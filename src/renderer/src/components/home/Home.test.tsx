/** @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptySnapshot, type DocSummary, type Snapshot } from '../../../../shared/model'
import { DocMenu } from './DocCard'
import { Home } from './Home'
import type { HomeView } from './useHomeView'
import { FIRST_WINDOW, NEXT_WINDOW } from './useMountWindow'

import '@testing-library/jest-dom/vitest'

/** Records each observer so a test can bring the sentinel into range. */
class FakeObserver {
  static live = new Set<FakeObserver>()
  readonly callback: IntersectionObserverCallback
  readonly options: IntersectionObserverInit | undefined
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.options = options
  }
  observe() {
    FakeObserver.live.add(this)
  }
  disconnect() {
    FakeObserver.live.delete(this)
  }
  /** Reports the sentinel within range to every live observer. */
  static reach() {
    for (const observer of FakeObserver.live) {
      observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], observer as never)
    }
  }
}

beforeEach(() => {
  FakeObserver.live.clear()
  vi.stubGlobal('IntersectionObserver', FakeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function library(size: number): Snapshot {
  const threads: DocSummary[] = Array.from({ length: size }, (_, index) => ({
    id: `thr_${index}`,
    name: `Doc ${index}`,
    preview: '',
    updatedAt: 1_700_000_000 - index,
    cwd: '/tmp',
    projectId: null,
  }))
  return { ...emptySnapshot(), status: 'ready', threads }
}

function home(snap: Snapshot, view: HomeView = 'grid') {
  return <Home snap={snap} view={view} onView={() => {}} onCreate={() => {}} projectId="all" onProject={() => {}} />
}

const shown = () => screen.queryAllByTestId(/^thread-/).length

describe('Home mounts the documents in view', () => {
  it('mounts the first batch, then more as the end nears, until all are in', () => {
    render(home(library(200)))
    expect(shown()).toBe(FIRST_WINDOW)
    expect([...FakeObserver.live][0]?.options?.rootMargin).toBe('0px 0px 1000px 0px')
    act(() => FakeObserver.reach())
    expect(shown()).toBe(FIRST_WINDOW + NEXT_WINDOW)
    act(() => FakeObserver.reach())
    expect(shown()).toBe(200)
    // Everything is in, so nothing watches the end any more.
    expect(FakeObserver.live.size).toBe(0)
  })

  it('starts over at the first batch when the view changes', () => {
    const snap = library(200)
    const { rerender } = render(home(snap))
    act(() => FakeObserver.reach())
    expect(shown()).toBe(FIRST_WINDOW + NEXT_WINDOW)
    rerender(home(snap, 'list'))
    expect(shown()).toBe(FIRST_WINDOW)
  })

  it('keeps the mounted batch through a snapshot patch that leaves the documents alone', () => {
    const snap = library(200)
    const { rerender } = render(home(snap))
    act(() => FakeObserver.reach())
    rerender(home({ ...snap, status: 'ready', streaming: true }))
    expect(shown()).toBe(FIRST_WINDOW + NEXT_WINDOW)
  })

  it('mounts a short library whole, with nothing watching the end', () => {
    render(home(library(12)))
    expect(shown()).toBe(12)
    expect(FakeObserver.live.size).toBe(0)
  })
})

describe("Home's shared document menu", () => {
  it('closes when Home goes, so it never outlives its button', async () => {
    const user = userEvent.setup()
    const snap = library(3)
    const { rerender } = render(
      <>
        <DocMenu />
        {home(snap)}
      </>,
    )
    await user.click(screen.getByTestId('more-thr_1'))
    expect(await screen.findByTestId('doc-open-new-tab')).toBeInTheDocument()
    rerender(<DocMenu />)
    await waitFor(() => expect(screen.queryByTestId('doc-open-new-tab')).toBeNull())
  })
})
