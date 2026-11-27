import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { checkBudgets, updateBudgets } from './budgets.mjs'
import { tier } from './report.mjs'

const options = { docs: 500, turns: 300, throttle: 1 }
const result = (counts, statics = {}, overrides = {}) => ({
  commit: 'abc1234',
  when: '2026-11-27T10:00:00.000Z',
  options: { runs: 0, shown: false, ...options },
  counts,
  static: statics,
  ...overrides,
})
const budgets = (metrics) => ({ measured: {}, options, metrics })
const statusOf = (checked) => Object.fromEntries(checked.rows.map((row) => [row.name, row.status]))

describe('checkBudgets', () => {
  const limits = budgets({
    'stream300.renders': { min: 900, max: 1100 },
    'static.main_js_kb': { min: 1800, max: 2201 },
  })

  it('passes within the bounds, and fails one count over the max', () => {
    expect(checkBudgets(result({ 'stream300.renders': 1100 }, { 'static.main_js_kb': 2201 }), limits).passed).toBe(true)
    const over = checkBudgets(result({ 'stream300.renders': 1101 }, { 'static.main_js_kb': 2000 }), limits)
    expect(over.passed).toBe(false)
    expect(statusOf(over)).toEqual({ 'stream300.renders': 'over', 'static.main_js_kb': 'ok' })
  })

  it('fails a count that fell under its min, so an improvement tightens its budget', () => {
    const stale = checkBudgets(result({ 'stream300.renders': 899 }, { 'static.main_js_kb': 2000 }), limits)
    expect(stale.passed).toBe(false)
    expect(statusOf(stale)['stream300.renders']).toBe('stale')
  })

  it('fails a budgeted metric the run did not produce, and one that is not a count', () => {
    const checked = checkBudgets(
      result({ 'stream300.task_ms': 5 }, { 'static.main_js_kb': 2000 }),
      budgets({ ...limits.metrics, 'stream300.task_ms': { min: 0, max: 10 } }),
    )
    expect(checked.passed).toBe(false)
    expect(statusOf(checked)).toEqual({
      'stream300.renders': 'missing',
      'static.main_js_kb': 'ok',
      'stream300.task_ms': 'not a count',
    })
  })

  it('fails a run of a different session, whose counts do not compare', () => {
    const small = result(
      { 'stream300.renders': 1000 },
      { 'static.main_js_kb': 2000 },
      { options: { ...options, turns: 30 } },
    )
    expect(checkBudgets(small, limits)).toMatchObject({ passed: false, differ: ['turns'] })
  })

  it('checks only the bundle sizes of a build when asked, with no session to compare', () => {
    const build = { commit: 'abc1234', static: { 'static.main_js_kb': 2300 } }
    const checked = checkBudgets(build, limits, { only: (name) => name.startsWith('static.') })
    expect(checked).toMatchObject({ passed: false, differ: [] })
    expect(statusOf(checked)).toEqual({ 'static.main_js_kb': 'over' })
  })
})

describe('updateBudgets', () => {
  it('sets bounds 10% outside the range the runs measured, at least 2 for whole counts', () => {
    const run = (renders, commits, mainKb) =>
      result(
        { 'stream300.renders': renders, 'open.commits': commits, 'stream300.r_ginstr': 99 },
        { 'static.main_js_kb': mainKb },
      )
    const next = updateBudgets(
      [run(900, 10, 1999.94), run(880, 11, 1999.94), run(890, 11, 1999.94)],
      budgets({
        'stream300.renders': { min: 0, max: 1100 },
        'open.commits': { min: 0, max: 12 },
        'static.main_js_kb': { min: 0, max: 2200 },
      }),
    )
    expect(next.metrics).toEqual({
      'stream300.renders': { low: 880, high: 900, min: 792, max: 990 },
      'open.commits': { low: 10, high: 11, min: 8, max: 13 },
      'static.main_js_kb': { low: 1999.9, high: 1999.9, min: 1799.9, max: 2200 },
    })
    expect(next.measured).toEqual({ commit: 'abc1234', when: '2026-11-27', runs: 3 })
  })

  it("keeps a metric's own headroom and slack, rounding fractional counts to 0.1", () => {
    const next = updateBudgets(
      [
        result({ 'reopen.ipc_kb': 1107.36, 'stream300.renders_per_commit_p50': 23 }),
        result({ 'reopen.ipc_kb': 1120.04, 'stream300.renders_per_commit_p50': 23 }),
      ],
      budgets({
        'reopen.ipc_kb': { min: 0, max: 0, headroom: 0.02 },
        'stream300.renders_per_commit_p50': { min: 0, max: 0, headroom: 0, slack: 0 },
      }),
    )
    expect(next.metrics).toEqual({
      'reopen.ipc_kb': { low: 1107.4, high: 1120, min: 1085.2, max: 1142.5, headroom: 0.02 },
      'stream300.renders_per_commit_p50': { low: 23, high: 23, min: 23, max: 23, headroom: 0, slack: 0 },
    })
  })

  it('never sets a max above a cap, and a build over its cap fails right after the update', () => {
    const build = result({}, { 'static.renderer_entry_js_kb': 520 })
    const next = updateBudgets([build], budgets({ 'static.renderer_entry_js_kb': { min: 0, max: 0, cap: 500 } }))
    expect(next.metrics['static.renderer_entry_js_kb']).toEqual({ low: 520, high: 520, min: 468, max: 500, cap: 500 })
    expect(statusOf(checkBudgets(build, next))).toEqual({ 'static.renderer_entry_js_kb': 'over' })
    const small = updateBudgets(
      [result({}, { 'static.renderer_entry_js_kb': 400 })],
      budgets({ 'static.renderer_entry_js_kb': { min: 0, max: 0, cap: 500 } }),
    )
    expect(small.metrics['static.renderer_entry_js_kb'].max).toBe(440)
  })

  it('refuses to budget a metric that is not a count, or one a run did not measure', () => {
    const run = result({ 'stream300.r_ginstr': 99, 'stream300.task_ms': 2000, 'stream300.renders': 5 })
    expect(() => updateBudgets([run], budgets({ 'stream300.task_ms': { min: 1, max: 1 } }))).toThrow(/not a count/)
    expect(() => updateBudgets([run, result({})], budgets({ 'stream300.renders': { min: 1, max: 1 } }))).toThrow(
      /did not measure/,
    )
  })
})

it('budgets only counts in the checked-in budgets.json', () => {
  const { metrics } = JSON.parse(readFileSync(new URL('./budgets.json', import.meta.url), 'utf8'))
  const names = Object.keys(metrics)
  expect(names.length).toBeGreaterThan(0)
  expect(names.filter((name) => tier(name) !== 'count')).toEqual([])
})
