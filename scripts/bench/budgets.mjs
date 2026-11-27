// Budgets for `pnpm bench:check`: count-tier bounds, checked in as budgets.json, that a
// counts run must stay within. Only counts are budgeted: they read the same, or within a
// few percent, on a busy machine, so the check needs no quiet machine and one run; times
// and instruction counts move with load and would make it flaky.
//
// Each metric has a range from the runs it was measured on (`low` to `high`) and two
// bounds: `max`, over which the check fails as a regression, and `min`, under which it
// fails as stale, so a change that lowers a count also tightens its budget and the gain
// cannot be lost again unnoticed.
//
// The idea follows T3 Code, whose payload budgets live in tests "so regressions fail
// locally" (docs/internals/performance-regressions.md at commit 5c6f2f12); no code is copied.
import { tier } from './report.mjs'

/** How far past its measured range a metric may go before the check fails, unless it sets its own. */
export const HEADROOM = 0.1
/** Whole counts may also always move by this much, so a small count (10 commits) can move by one or two. */
const MIN_SLACK = 2

/** The run options that change what a session does; a budget holds only for the same ones. */
const SESSION_OPTIONS = ['docs', 'turns', 'throttle']

/** Every number a counts run measured: its phases, the session total and the build's sizes. */
export function measured(result) {
  const all = { ...result.counts, ...result.static }
  return Object.fromEntries(Object.entries(all).filter(([, value]) => typeof value === 'number'))
}

// Rounded to 6 places first, so float error (900 * 1.1 = 990.0000000000001) does not add a step.
const up = (value, step) => Math.ceil(Number((value / step).toFixed(6))) * step
const down = (value, step) => Math.floor(Number((value / step).toFixed(6))) * step
const round = (value) => Math.round(value * 10) / 10

/**
 * The bounds for a measured range. Whole counts round to whole numbers and get at least
 * `MIN_SLACK` either side; fractional ones (kilobytes, renders per commit) round to 0.1.
 */
function boundsFor(low, high, headroom) {
  const whole = Number.isInteger(low) && Number.isInteger(high)
  const step = whole ? 1 : 0.1
  const slack = whole ? MIN_SLACK : 0
  return {
    min: round(Math.max(0, Math.min(down(low * (1 - headroom), step), low - slack))),
    max: round(Math.max(up(high * (1 + headroom), step), high + slack)),
  }
}

/**
 * Checks `result` against `budgets`. Every budgeted metric must be a count, measured, and
 * within its bounds: over `max` is a regression, under `min` a stale budget, and a metric
 * the run did not produce fails too, so a renamed phase cannot pass silently. `only`
 * limits the check to some metrics (the bundle sizes, which need no app).
 */
export function checkBudgets(result, budgets, { only = () => true } = {}) {
  const values = measured(result)
  const staticOnly = Object.keys(budgets.metrics)
    .filter(only)
    .every((name) => name.startsWith('static.'))
  const differ = staticOnly ? [] : SESSION_OPTIONS.filter((key) => result.options?.[key] !== budgets.options?.[key])
  const rows = Object.entries(budgets.metrics)
    .filter(([name]) => only(name))
    .map(([name, { min, max }]) => {
      const value = values[name]
      const status =
        tier(name) !== 'count'
          ? 'not a count'
          : value === undefined
            ? 'missing'
            : value > max
              ? 'over'
              : value < min
                ? 'stale'
                : 'ok'
      return { name, min, max, value: value === undefined ? null : round(value), status }
    })
  return { rows, differ, passed: differ.length === 0 && rows.every((row) => row.status === 'ok') }
}

/**
 * New budgets from `results` (counts runs of one build): the same metrics as `budgets`,
 * each with the range the runs measured and bounds `headroom` outside it. A metric keeps
 * its own `headroom` if it has one. Throws when a metric is missing or not a count, so a
 * bad run cannot write a budget that would pass anything.
 */
export function updateBudgets(results, budgets) {
  const [result] = results
  const runs = results.map(measured)
  const metrics = {}
  for (const [name, previous] of Object.entries(budgets.metrics)) {
    if (tier(name) !== 'count') throw new Error(`${name} is not a count; only counts can be budgeted`)
    if (runs.some((values) => values[name] === undefined)) throw new Error(`the run did not measure ${name}`)
    const values = runs.map((run) => run[name])
    const [low, high] = [Math.min(...values), Math.max(...values)]
    const own = previous.headroom === undefined ? {} : { headroom: previous.headroom }
    metrics[name] = { low: round(low), high: round(high), ...boundsFor(low, high, own.headroom ?? HEADROOM), ...own }
  }
  return {
    ...budgets,
    measured: { commit: result.commit, when: result.when.slice(0, 10), runs: results.length },
    options: Object.fromEntries(SESSION_OPTIONS.map((key) => [key, result.options[key]])),
    metrics,
  }
}

const pad = (text, width) => String(text).padEnd(width)
const padStart = (text, width) => String(text).padStart(width)
const NOTES = {
  over: (row) => `OVER by ${round(row.value - row.max)}`,
  stale: (row) => `STALE: ${round(row.min - row.value)} under its min; the budget is too loose`,
  missing: () => 'MISSING from the run',
  'not a count': () => 'NOT A COUNT: only counts can be budgeted',
  ok: () => 'ok',
}

/** The check as a plain-text table, with a line saying what to do when it failed. */
export function checkReport({ rows, differ, passed }, budgets) {
  const width = Math.max(...rows.map((row) => row.name.length))
  const lines = [
    `${pad('metric', width)}  ${padStart('min', 9)}  ${padStart('max', 9)}  ${padStart('measured', 9)}  status`,
  ]
  for (const row of rows) {
    lines.push(
      `${pad(row.name, width)}  ${padStart(row.min, 9)}  ${padStart(row.max, 9)}  ${padStart(row.value ?? '-', 9)}  ${NOTES[row.status](row)}`,
    )
  }
  if (differ.length) {
    const sides = differ.map((key) => `${key} ${budgets.options?.[key]}`).join(', ')
    lines.push('', `The budgets hold for the default session (${sides}); run the check without changing them.`)
  }
  const stale = rows.some((row) => row.status === 'stale')
  lines.push(
    '',
    passed
      ? 'All budgets met.'
      : stale && rows.every((row) => row.status === 'ok' || row.status === 'stale')
        ? 'A budget is stale: a count fell. Run `pnpm bench:check --update` and commit budgets.json, so the gain is kept (docs/performance.md).'
        : 'Over budget. Fix the regression, or if the change is intended, run `pnpm bench:check --update`, commit budgets.json and say why in the PR (docs/performance.md).',
  )
  return `${lines.join('\n')}\n`
}
