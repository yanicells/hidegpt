/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProgressiveRows } from './useProgressiveRows'

// A MessageChannel whose messages wait in `queued` until the test delivers them.
const queued: Array<() => void> = []
const channels: FakeChannel[] = []
class FakeChannel {
  closed = false
  port1 = {
    onmessage: null as (() => void) | null,
    close: () => {
      this.closed = true
    },
  }
  port2 = { postMessage: () => queued.push(() => this.port1.onmessage?.()) }
  constructor() {
    channels.push(this)
  }
}

// Fake time: each render of the hook costs `renderMs`.
let now = 0
let renderMs = 0
let renders = 0

beforeEach(() => {
  queued.length = 0
  channels.length = 0
  now = 0
  renderMs = 0
  renders = 0
  vi.stubGlobal('MessageChannel', FakeChannel)
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const open = (count: number) =>
  renderHook(
    ({ rows }) => {
      now += renderMs
      renders++
      return useProgressiveRows(rows)
    },
    { initialProps: { rows: count } },
  )

// Delivers the queued step, whose render takes `ms`. A void callback keeps act synchronous.
const nextTask = (ms: number) =>
  act(() => {
    renderMs = ms
    queued.splice(0).forEach((deliver) => deliver())
  })

describe('useProgressiveRows', () => {
  it('opens a screenful and renders new rows at once when every row is on the page', () => {
    const { result, rerender } = open(40)
    expect(result.current).toBe(12)
    nextTask(10)
    expect(result.current).toBe(24)
    nextTask(10)
    nextTask(10)
    expect(result.current).toBe(40)
    expect(queued).toHaveLength(0)
    // The open plus one render per step: the last step needs no extra render to latch.
    expect(renders).toBe(4)

    // "Load earlier" or a new turn after the document is fully open.
    rerender({ rows: 70 })
    expect(result.current).toBe(70)
    expect(queued).toHaveLength(0)
  })

  it('renders a short document in one go', () => {
    const { result } = open(5)
    expect(result.current).toBe(5)
    expect(channels).toHaveLength(0)
    expect(renders).toBe(1)
  })

  it('doubles the step while the previous one took under 8 ms', () => {
    const { result } = open(500)
    const limits = [result.current]
    for (let i = 0; i < 5; i++) {
      nextTask(7)
      limits.push(result.current)
    }
    expect(limits).toEqual([12, 24, 48, 96, 192, 384])
  })

  it('keeps the step from 8 to 16 ms and halves it over 16 ms', () => {
    const { result } = open(500)
    const limits = [result.current]
    for (const ms of [8, 16, 17, 17, 17, 17, 17]) {
      nextTask(ms)
      limits.push(result.current)
    }
    // Steps: 12, 12, 12, then halved down to one row a task.
    expect(limits).toEqual([12, 24, 36, 48, 54, 57, 58, 59])
  })

  it('does no work after unmount', () => {
    const { result, unmount } = open(500)
    nextTask(1)
    expect(result.current).toBe(24)
    expect(queued).toHaveLength(1)

    unmount()
    expect(channels.every((channel) => channel.closed)).toBe(true)
    const errors = vi.spyOn(console, 'error')
    nextTask(1)
    expect(result.current).toBe(24)
    expect(errors).not.toHaveBeenCalled()
  })
})
