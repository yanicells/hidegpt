import { afterEach, describe, expect, it, vi } from 'vitest'

import { clockScript, PINNED_START, pinClock, startStep } from './clock'

// pinClock replaces this process's Date, so it has a file of its own and puts Date back.
const original = { Date: globalThis.Date }
afterEach(() => {
  globalThis.Date = original.Date
  vi.useRealTimers()
})

describe('pinClock (main)', () => {
  it('shifts main to PINNED_START, then follows the reload and step resets', () => {
    vi.useFakeTimers({ now: Date.UTC(2031, 5, 9, 8, 7, 6) })
    original.Date = globalThis.Date
    pinClock()
    expect(Date.now()).toBe(PINNED_START)
    expect(new Date().toISOString()).toBe('2026-03-02T15:00:00.000Z')
    expect(new Date(0).getTime()).toBe(0)

    // Real time keeps moving under the pin.
    vi.setSystemTime(original.Date.now() + 40_000)
    expect(Date.now()).toBe(PINNED_START + 40_000)

    // The reload resets main to 15:00:00, and each step to its own minute.
    clockScript()
    expect(Date.now()).toBe(PINNED_START)
    startStep()
    vi.setSystemTime(original.Date.now() + 90_000)
    startStep()
    expect(new Date().toISOString()).toBe('2026-03-02T15:02:00.000Z')
  })
})
