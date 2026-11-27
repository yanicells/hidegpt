// Budgets for `pnpm bench:check`: count-tier maxima, checked in as budgets.json, that a
// counts run must stay under. Only counts are budgeted: they read the same, or within a
// few percent, on a busy machine, so the check needs no quiet machine and one run; times
// and instruction counts move with load and would make it flaky.
//
// The idea follows T3 Code, whose payload budgets live in tests "so regressions fail
// locally" (docs/internals/performance-regressions.md at commit 5c6f2f12); no code is copied.
import { tier } from './report.mjs'

/** How far over its baseline a metric may go before the check fails: 10%, and at least 2. */
export const HEADROOM = 0.1
const MIN_SLACK = 2

/** The run options that change what a session does; a budget holds only for the same ones. */
const SESSION_OPTIONS = ['docs', 'turns', 'throttle']

/** Every number a counts run measured: its phases, the session total and the build's sizes. */
export function measured(result) {
  const all = { ...result.counts, ...result.static }
  return Object.fromEntries(Object.entries(all).filter(([, value]) => typeof value === 'number'))
}

/**
 * The budget for a baseline: `HEADROOM` over it, rounded up to a whole number, and at least
 * `MIN_SLACK` over it, so a small count (10 commits) can move by one or two.
 */
const budgetFor = (baseline) =>
  // Rounded to 6 places first, so float error (900 * 1.1 = 990.0000000000001) does not add one.
  Math.max(Math.ceil(Number((baseline * (1 + HEADROOM)).toFixed(6))), Math.ceil(baseline) + MIN_SLACK)

const round = (value) => Math.round(value * 10) / 10

/**
 * Checks `result` against `budgets`. Every budgeted metric must be measured and at or under
 * its max; a metric the run did not produce fails too, so a renamed phase cannot pass
 * silently. Returns one row per metric and whether all passed.
 */
export function checkBudgets(result, budgets) {
  const values = measured(result)
  const differ = SESSION_OPTIONS.filter((key) => result.options?.[key] !== budgets.options?.[key])
  const rows = Object.entries(budgets.metrics).map(([name, { baseline, max }]) => {
    const value = values[name]
    const status = value === undefined ? 'missing' : value > max ? 'over' : 'ok'
    return { name, baseline, max, value: value === undefined ? null : round(value), status }
  })
  return { rows, differ, passed: differ.length === 0 && rows.every((row) => row.status === 'ok') }
}

/**
 * New budgets from `results` (counts runs of one build): the same metrics as `budgets`, each
 * with the highest value the runs measured as its baseline, so a count that moves a few
 * percent between runs is budgeted from its high side. Throws when a metric is missing or
 * not a count, so a bad run cannot write a budget that would pass anything.
 */
export function updateBudgets(results, budgets) {
  const [result] = results
  const runs = results.map(measured)
  const metrics = {}
  for (const name of Object.keys(budgets.metrics)) {
    if (tier(name) !== 'count') throw new Error(`${name} is not a count; only counts can be budgeted`)
    if (runs.some((values) => values[name] === undefined)) throw new Error(`the run did not measure ${name}`)
    const high = Math.max(...runs.map((values) => values[name]))
    metrics[name] = { baseline: round(high), max: budgetFor(high) }
  }
  return {
    ...budgets,
    measured: { commit: result.commit, when: result.when.slice(0, 10) },
    options: Object.fromEntries(SESSION_OPTIONS.map((key) => [key, result.options[key]])),
    metrics,
  }
}

const pad = (text, width) => String(text).padEnd(width)
const padStart = (text, width) => String(text).padStart(width)

/** The check as a plain-text table, with a line saying what to do when it failed. */
export function checkReport({ rows, differ, passed }, budgets) {
  const width = Math.max(...rows.map((row) => row.name.length))
  const lines = [`${pad('metric', width)}  ${padStart('budget', 9)}  ${padStart('measured', 9)}  status`]
  for (const row of rows) {
    const note =
      row.status === 'over'
        ? `OVER by ${round(row.value - row.max)}`
        : row.status === 'missing'
          ? 'MISSING from the run'
          : `ok (${round(row.max - row.value)} left)`
    lines.push(`${pad(row.name, width)}  ${padStart(row.max, 9)}  ${padStart(row.value ?? '-', 9)}  ${note}`)
  }
  if (differ.length) {
    const sides = differ.map((key) => `${key} ${budgets.options?.[key]}`).join(', ')
    lines.push('', `The budgets hold for the default session (${sides}); run the check without changing them.`)
  }
  lines.push(
    '',
    passed
      ? 'All budgets met.'
      : 'Over budget. Fix the regression, or if the change is intended, run `pnpm bench:check --update`, commit budgets.json and say why in the PR (docs/performance.md).',
  )
  return `${lines.join('\n')}\n`
}
