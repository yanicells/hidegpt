import { runInNewContext } from 'node:vm'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { clockScript, PINNED_START, startStep } from './clock'

afterEach(() => {
  vi.useRealTimers()
})

/** A fresh realm standing in for the renderer, sharing this process's (fake) `Date`. */
const renderer = () => {
  const page = { Date }
  runInNewContext(clockScript(), page)
  return { page, read: <A>(expression: string) => runInNewContext(expression, page) as A }
}

describe('the pinned clock', () => {
  it('starts the renderer at PINNED_START and keeps real time moving', () => {
    vi.useFakeTimers({ now: Date.UTC(2031, 5, 9, 8, 7, 6) })
    const { read } = renderer()
    expect(read<number>('Date.now()')).toBe(PINNED_START)
    vi.setSystemTime(Date.now() + 2_500)
    expect(read<string>('new Date().toISOString()')).toBe('2026-03-02T15:00:02.500Z')
    // Explicit dates and the static helpers are untouched.
    expect(read<number>('new Date(0).getTime()')).toBe(0)
    expect(read<number>('Date.UTC(2020, 0, 1)')).toBe(Date.UTC(2020, 0, 1))
    expect(read<string>('typeof Date()')).toBe('string')
  })

  it('starts step n at PINNED_START plus n minutes, however long earlier steps ran', () => {
    vi.useFakeTimers({ now: Date.UTC(2031, 5, 9, 8, 7, 6) })
    const { page, read } = renderer()
    vi.setSystemTime(Date.now() + 5_000)
    runInNewContext(startStep(), page)
    expect(read<number>('Date.now()')).toBe(PINNED_START + 60_000)
    // A step that overruns its minute doesn't push the next one later.
    vi.setSystemTime(Date.now() + 90_000)
    runInNewContext(startStep(), page)
    expect(read<string>('new Date().toISOString()')).toBe('2026-03-02T15:02:00.000Z')
  })
})
