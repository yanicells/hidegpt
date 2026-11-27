// Turns bench runs into medians with their spread, and into Markdown tables.

/**
 * How far a metric can be trusted on a busy machine, from its name.
 *   count   exact: the same build gives the same number whatever else is running
 *   instr   instructions retired: within 2% under load for streaming and scrolling, more elsewhere
 *   cpu     CPU time: drifts with core type and contention
 *   memory  heap and footprint: stable, footprint varies a little
 *   wall    latency and frame timing: only meaningful on a quiet machine
 */
export function tier(name) {
  const metric = name.split('.').pop()
  if (/_ginstr$/.test(metric)) return 'instr'
  if (/^(layouts|recalcs|ipc_sends|ipc_kb|commits|renders|dom_nodes|blocks|blocks_added|deltas|chars|pages|cards|keys)$/.test(metric) || name.startsWith('static.')) return 'count'
  if (/_mb$/.test(metric)) return 'memory'
  if (/^(layout_ms|recalc_ms|script_ms|task_ms)$/.test(metric) || /_cpu_ms$/.test(metric)) return 'cpu'
  return 'wall'
}

/**
 * The numbers a person feels, plus the counters that explain them. `cold.fcp_ms` is left
 * out: in a window that is never shown, first paint can be reported after the first card
 * has painted, so it does not mark when anything reached the screen.
 */
export const HEADLINE = [
  'cold.first_card_ms',
  'cold.all_cards_ms',
  'cold.listed_ms',
  'cold.m_ginstr',
  'cold.r_ginstr',
  'cold.lag_max_ms',
  'home_list.settled_ms',
  'home_list.r_ginstr',
  'open.first_ms',
  'open.settled_ms',
  'open.r_ginstr',
  'open.longtask_max_ms',
  'type_idle.key_p95_ms',
  'stream30.r_ginstr',
  'stream30.m_ginstr',
  'stream30.g_ginstr',
  'stream30.layouts',
  'stream30.recalcs',
  'stream30.layout_ms',
  'stream30.recalc_ms',
  'stream30.script_ms',
  'stream30.ipc_sends',
  'stream30.frame_p95_ms',
  'stream30.late_frames',
  'stream30.end_lag_ms',
  'code30.r_ginstr',
  'load_all.total_ms',
  'load_all.r_ginstr',
  'stream300.r_ginstr',
  'stream300.m_ginstr',
  'stream300.g_ginstr',
  'stream300.layouts',
  'stream300.layout_ms',
  'stream300.recalc_ms',
  'stream300.script_ms',
  'stream300.frame_p95_ms',
  'stream300.late_frames',
  'stream300.longtask_sum_ms',
  'type_stream300.key_p95_ms',
  'type_idle300.key_p95_ms',
  'scroll300.r_ginstr',
  'scroll300.frame_p95_ms',
  'scroll300.late_frames',
  'to_home.settled_ms',
  'open_other.settled_ms',
  'reopen.settled_ms',
  'mem300.r_heap_mb',
  'mem300.r_footprint_mb',
  'mem300.dom_nodes',
  'mem_end.r_footprint_mb',
  'mem_end.m_footprint_mb',
  'mem_end.g_footprint_mb',
  'static.renderer_entry_js_kb',
  'static.renderer_css_kb',
  'static.main_js_kb',
]

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** Median of the finite numbers in `values` (others are ignored); `null` when there are none. */
export function median(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** `{metric: {median, min, max, n}}` over runs, for every numeric metric. */
export function summarize(runs) {
  const summary = {}
  for (const name of new Set(runs.flatMap((run) => Object.keys(run)))) {
    const values = runs.map((run) => run[name]).filter(finite)
    if (values.length) summary[name] = { median: median(values), min: Math.min(...values), max: Math.max(...values), n: values.length }
  }
  return summary
}

const format = (value) => {
  if (value === undefined || value === null) return '–'
  const abs = Math.abs(value)
  return abs >= 1000 ? Math.round(value).toLocaleString('en-US') : abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(2)
}
const row = (cells) => `| ${cells.join(' | ')} |`

/** Every metric of a result as `{median, min, max, n}`: timed runs, then the counts run and static sizes. */
function flat(result) {
  const all = {}
  // Results written before `n` was recorded count it from their runs.
  for (const [name, stat] of Object.entries(result.summary ?? {})) {
    all[name] = { ...stat, n: stat.n ?? (result.runs ?? []).filter((run) => finite(run[name])).length }
  }
  const single = (value) => ({ median: value, min: value, max: value, n: 1 })
  for (const [name, value] of Object.entries(result.counts ?? {})) {
    if (typeof value === 'number' && /\.(commits|renders|ipc_kb)$/.test(name)) all[name] = single(value)
  }
  for (const [name, value] of Object.entries(result.static ?? {})) all[name] = single(value)
  return all
}

const pick = (all, { only, all: everything }) => (only && !everything ? only.filter((name) => all[name]) : Object.keys(all).sort())

export function resultTable(result, options = {}) {
  const all = flat(result)
  const lines = [
    `### ${result.label} (${result.commit}), ${result.options.runs} runs, ${result.when.slice(0, 16)}Z`,
    '',
    row(['metric', 'tier', 'median', 'min – max']),
    row(['---', '---', '---:', '---:']),
  ]
  for (const name of pick(all, options)) {
    const { median: mid, min, max } = all[name]
    lines.push(row([name, tier(name), format(mid), min === max ? '' : `${format(min)} – ${format(max)}`]))
  }
  return `${lines.join('\n')}\n`
}

/** The run options that change what a session does; results that differ in them do not compare. */
const SESSION_OPTIONS = ['docs', 'turns', 'throttle']

const percent = (from, to) => {
  if (from === 0) return to === 0 ? '0%' : 'new'
  const change = (to - from) / Math.abs(from)
  return `${change >= 0 ? '+' : ''}${(change * 100).toFixed(0)}%`
}

/** How far apart two `{median, min, max, n}` are, as the last column of the comparison. */
export function verdict(name, from, to) {
  if (from.median === to.median) return 'same'
  // A count is exact, so one sample is enough; anything else needs a spread to compare against.
  if ((from.n < 2 || to.n < 2) && tier(name) !== 'count') return '1 sample'
  if (!(from.min > to.max || to.min > from.max)) return 'within spread'
  if (from.median <= 0 || to.median <= 0) return 'real'
  return from.median >= to.median ? `real, ${(from.median / to.median).toFixed(2)}x less` : `real, ${(to.median / from.median).toFixed(2)}x more`
}

/**
 * Before against after, over the metrics of both. A change is marked `real` only when the
 * two ranges do not overlap; wall-clock metrics from a busy machine rarely earn it.
 */
export function compareTable(before, after, options = {}) {
  const a = flat(before)
  const b = flat(after)
  const both = { ...a, ...b }
  const names = pick(both, { only: HEADLINE, ...options })
  const lines = [`### ${before.label} (${before.commit}) → ${after.label} (${after.commit})`, '']
  const differ = SESSION_OPTIONS.filter((key) => before.options?.[key] !== after.options?.[key])
  if (differ.length) {
    const sides = differ.map((key) => `${key} ${before.options?.[key]} vs ${after.options?.[key]}`).join(', ')
    lines.push(`> Warning: the two ran different sessions (${sides}); their numbers do not compare.`, '')
  }
  lines.push(row(['metric', 'tier', before.label, after.label, 'change', '']), row(['---', '---', '---:', '---:', '---:', '---']))
  for (const name of names) {
    const from = a[name]
    const to = b[name]
    if (!from || !to) {
      lines.push(row([name, tier(name), format(from?.median), format(to?.median), '–', from ? 'only in before' : 'only in after']))
      continue
    }
    lines.push(row([name, tier(name), format(from.median), format(to.median), percent(from.median, to.median), verdict(name, from, to)]))
  }
  return `${lines.join('\n')}\n`
}
