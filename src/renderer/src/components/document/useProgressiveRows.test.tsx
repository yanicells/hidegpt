/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProgressiveRows } from './useProgressiveRows'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const nextTask = () => act(() => vi.runOnlyPendingTimers())

describe('useProgressiveRows', () => {
  it('opens a screenful, adds a step per task, then renders new rows at once', () => {
    const { result, rerender } = renderHook(({ count }) => useProgressiveRows(count), { initialProps: { count: 40 } })
    expect(result.current).toBe(12)
    nextTask()
    expect(result.current).toBe(24)
    nextTask()
    nextTask()
    expect(result.current).toBe(40)

    // "Load earlier" or a new turn after the document is fully open.
    rerender({ count: 70 })
    expect(result.current).toBe(70)
  })

  it('renders a short document in one go', () => {
    const { result } = renderHook(() => useProgressiveRows(5))
    expect(result.current).toBe(5)
    expect(vi.getTimerCount()).toBe(0)
  })
})
