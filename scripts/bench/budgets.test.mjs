import { describe, expect, it } from 'vitest'

import { checkBudgets, updateBudgets } from './budgets.mjs'

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

describe('checkBudgets', () => {
  const limits = budgets({
    'stream300.renders': { baseline: 1000, max: 1100 },
    'static.main_js_kb': { baseline: 2000.4, max: 2201 },
  })

  it('passes at the budget and fails one count over it', () => {
    expect(checkBudgets(result({ 'stream300.renders': 1100 }, { 'static.main_js_kb': 2201 }), limits).passed).toBe(true)
    const over = checkBudgets(result({ 'stream300.renders': 1101 }, { 'static.main_js_kb': 2000 }), limits)
    expect(over.passed).toBe(false)
    expect(over.rows.map((row) => row.status)).toEqual(['over', 'ok'])
  })

  it('fails a budgeted metric the run did not produce', () => {
    const checked = checkBudgets(result({}, { 'static.main_js_kb': 2000 }), limits)
    expect(checked.passed).toBe(false)
    expect(checked.rows[0]).toMatchObject({ name: 'stream300.renders', status: 'missing', value: null })
  })

  it('fails a run of a different session, whose counts do not compare', () => {
    const small = result(
      { 'stream300.renders': 10 },
      { 'static.main_js_kb': 2000 },
      { options: { ...options, turns: 30 } },
    )
    expect(checkBudgets(small, limits)).toMatchObject({ passed: false, differ: ['turns'] })
  })
})

describe('updateBudgets', () => {
  it('rebaselines each metric from the higher of the runs, 10% (and at least 2) over it, rounded up', () => {
    const run = (renders, commits, mainKb) =>
      result(
        { 'stream300.renders': renders, 'open.commits': commits, 'stream300.r_ginstr': 99 },
        { 'static.main_js_kb': mainKb },
      )
    const next = updateBudgets(
      [run(900, 10, 1999.94), run(880, 11, 1999.94)],
      budgets({
        'stream300.renders': { baseline: 1000, max: 1100 },
        'open.commits': { baseline: 10, max: 12 },
        'static.main_js_kb': { baseline: 2000, max: 2200 },
      }),
    )
    expect(next.metrics).toEqual({
      'stream300.renders': { baseline: 900, max: 990 },
      'open.commits': { baseline: 11, max: 13 },
      'static.main_js_kb': { baseline: 1999.9, max: 2200 },
    })
    expect(next.measured).toEqual({ commit: 'abc1234', when: '2026-11-27' })
  })

  it('refuses to budget a metric that is not a count, or one a run did not measure', () => {
    const run = result({ 'stream300.r_ginstr': 99, 'stream300.task_ms': 2000, 'stream300.renders': 5 })
    expect(() => updateBudgets([run], budgets({ 'stream300.task_ms': { baseline: 1, max: 1 } }))).toThrow(/not a count/)
    expect(() => updateBudgets([run, result({})], budgets({ 'stream300.renders': { baseline: 1, max: 1 } }))).toThrow(
      /did not measure/,
    )
  })
})
