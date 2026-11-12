// Turns bench runs into medians with their spread, and into Markdown tables.

/**
 * How far a metric can be trusted on a busy machine, from its name.
 *   count  exact: the same build gives the same number whatever else is running
 *   instr  instructions retired: within about 1% under load
 *   cpu    CPU time: drifts with core type and contention
 *   wall   latency and frame timing: only meaningful on a quiet machine
 */
export function tier(name) {
  const metric = name.split('.').pop()
  if (/_ginstr$/.test(metric)) return 'instr'
  if (/^(layouts|recalcs|ipc_sends|ipc_kb|commits|renders|dom_nodes|blocks|blocks_added|deltas|chars|pages|cards|keys)$/.test(metric) || name.startsWith('static.')) return 'count'
  if (/_mb$/.test(metric)) return 'memory'
  if (/^(layout_ms|recalc_ms|script_ms|task_ms)$/.test(metric) || /_cpu_ms$/.test(metric)) return 'cpu'
  return 'wall'
}

/** The numbers a person feels, plus the counters that explain them. */
export const HEADLINE = [
  'cold.fcp_ms',
  'cold.all_cards_ms',
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

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** `{metric: {median, min, max}}` over runs, for every numeric metric. */
export function summarize(runs) {
  const summary = {}
  for (const name of new Set(runs.flatMap((run) => Object.keys(run)))) {
    const values = runs.map((run) => run[name]).filter((value) => typeof value === 'number' && Number.isFinite(value))
    if (values.length) summary[name] = { median: median(values), min: Math.min(...values), max: Math.max(...values) }
  }
  return summary
}

const format = (value) => {
  if (value === undefined || value === null) return '–'
  const abs = Math.abs(value)
  return abs >= 1000 ? Math.round(value).toLocaleString('en-US') : abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(2)
}
const row = (cells) => `| ${cells.join(' | ')} |`

/** Every metric of a result as `{median, min, max}`: timed runs, then the counts run and static sizes. */
function flat(result) {
  const all = { ...result.summary }
  const single = (value) => ({ median: value, min: value, max: value })
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

/**
 * Before against after. A change is marked `real` only when the two ranges do not
 * overlap; wall-clock metrics from a busy machine rarely earn it.
 */
export function compareTable(before, after, options = {}) {
  const a = flat(before)
  const b = flat(after)
  const names = pick(a, { only: HEADLINE, ...options }).filter((name) => b[name])
  const lines = [
    `### ${before.label} (${before.commit}) → ${after.label} (${after.commit})`,
    '',
    row(['metric', 'tier', before.label, after.label, 'change', '']),
    row(['---', '---', '---:', '---:', '---:', '---']),
  ]
  for (const name of names) {
    const from = a[name]
    const to = b[name]
    const change = from.median === 0 ? (to.median === 0 ? 0 : Infinity) : (to.median - from.median) / Math.abs(from.median)
    const apart = from.min > to.max || to.min > from.max
    const ratio = to.median > 0 && from.median > 0 ? (from.median >= to.median ? `${(from.median / to.median).toFixed(2)}x less` : `${(to.median / from.median).toFixed(2)}x more`) : ''
    lines.push(
      row([
        name,
        tier(name),
        format(from.median),
        format(to.median),
        Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${(change * 100).toFixed(0)}%` : 'new',
        apart ? `real, ${ratio}` : from.median === to.median ? 'same' : 'within spread',
      ]),
    )
  }
  return `${lines.join('\n')}\n`
}
