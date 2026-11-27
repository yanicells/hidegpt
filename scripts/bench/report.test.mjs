import { describe, expect, it } from 'vitest'

import { owner } from './profile.mjs'
import { compareTable, median, tier, verdict } from './report.mjs'

const stat = (median, min = median, max = median, n = 3) => ({ median, min, max, n })
const result = (label, summary, options = {}) => ({
  label,
  commit: label,
  options: { runs: 3, docs: 500, turns: 300, throttle: 1, shown: false, ...options },
  summary,
})
/** The comparison row for `name`. */
const rowOf = (table, name) => table.split('\n').find((line) => line.startsWith(`| ${name} |`))

describe('median', () => {
  it('takes the middle value, the mean of the middle two, and skips non-finite values', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([1, Number.NaN, 3, Infinity, null])).toBe(2)
    expect(median([])).toBeNull()
  })
})

describe('tier', () => {
  it('reads the tier from the metric name', () => {
    expect(tier('stream300.layouts')).toBe('count')
    expect(tier('static.main_js_kb')).toBe('count')
    expect(tier('stream300.r_ginstr')).toBe('instr')
    expect(tier('open.r_cpu_ms')).toBe('cpu')
    expect(tier('mem300.r_heap_mb')).toBe('memory')
    expect(tier('open.settled_ms')).toBe('wall')
  })
})

describe('verdict', () => {
  it('marks a change real only when the ranges do not overlap', () => {
    expect(verdict('open.settled_ms', stat(100, 90, 110), stat(95, 85, 105))).toBe('within spread')
    expect(verdict('open.settled_ms', stat(100, 90, 110), stat(50, 45, 55))).toBe('real, 2.00x less')
  })
  it('gives no ratio when before is 0', () => {
    expect(verdict('stream30.late_frames', stat(0), stat(4, 3, 5))).toBe('real')
  })
  it('does not call a single sample real, except for React counts and shipped sizes', () => {
    const one = (value) => stat(value, value, value, 1)
    expect(verdict('open.settled_ms', one(100), one(50))).toBe('1 sample')
    expect(verdict('cold.ipc_kb', one(1743), one(1475))).toBe('1 sample')
    expect(verdict('stream30.renders', one(100), one(50))).toBe('real, 2.00x less')
    expect(verdict('static.main_js_kb', one(2876), one(1100))).toBe('real, 2.61x less')
  })
})

describe('compareTable', () => {
  it('lists a metric found on one side only', () => {
    const table = compareTable(
      result('a', { 'cold.listed_ms': stat(300) }),
      result('b', { 'cold.all_cards_ms': stat(320) }),
    )
    expect(rowOf(table, 'cold.listed_ms')).toContain('only in before')
    expect(rowOf(table, 'cold.all_cards_ms')).toContain('only in after')
  })
  it('counts the samples of a result written before `n` was recorded from its runs', () => {
    const old = (label, values) => ({
      ...result(label, {
        'open.settled_ms': { median: values[0], min: Math.min(...values), max: Math.max(...values) },
      }),
      runs: values.map((value) => ({ 'open.settled_ms': value })),
    })
    expect(rowOf(compareTable(old('a', [100]), old('b', [50])), 'open.settled_ms')).toContain('1 sample')
    expect(rowOf(compareTable(old('a', [100, 100, 100]), old('b', [50, 50, 50])), 'open.settled_ms')).toContain(
      'real, 2.00x less',
    )
  })
  it('takes React counts and IPC bytes from the counts run', () => {
    const counted = (label, counts) => ({ ...result(label, {}), counts })
    const table = compareTable(
      counted('a', { 'stream30.renders': 100, 'stream30.ipc_kb': 304 }),
      counted('b', { 'stream30.renders': 50, 'stream30.ipc_kb': 35 }),
      { all: true },
    )
    expect(rowOf(table, 'stream30.renders')).toContain('real, 2.00x less')
    expect(rowOf(table, 'stream30.ipc_kb')).toContain('1 sample')
  })
  it('warns when the sessions differ', () => {
    expect(compareTable(result('a', {}), result('b', {}, { docs: 20 }))).toContain('docs 500 vs 20')
    expect(compareTable(result('a', {}), result('b', {}, { shown: true }))).toContain('shown false vs true')
    expect(compareTable(result('a', {}), result('b', {}))).not.toContain('Warning')
  })
})

describe('owner', () => {
  it('names the package or the source file', () => {
    expect(owner('../node_modules/.pnpm/a@1/node_modules/@scope/pkg/x.js')).toBe('@scope/pkg')
    expect(owner('../node_modules/.pnpm/react@19/node_modules/react/index.js')).toBe('react')
    expect(owner('../../src/renderer/src/App.tsx')).toBe('src/renderer/src/App.tsx')
    expect(owner('../../vite/preload-helper')).toBe('vite/preload-helper')
  })
})
