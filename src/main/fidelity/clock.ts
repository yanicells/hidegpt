/**
 * Fidelity captures pin the clock so "Opened 3:42 PM", recency groups and
 * suggestion timestamps read the same on every run. `Date` is shifted by an
 * offset that is set at boot, reset to 15:00:00 when the page reloads, and set
 * again as each step starts: step n starts at 15:00 plus n minutes, however long
 * the steps before it took. Between those points time runs at its real rate, so
 * every deadline keeps its length. A minute shown on screen can only roll inside
 * a step longer than a minute, and the step after one goes back in time.
 */

/** Monday 2 March 2026, 15:00 UTC: mid-afternoon, so the demo's "today" documents stay today. */
export const PINNED_START = Date.UTC(2026, 2, 2, 15, 0, 0)

/**
 * Replaces the global `Date` with one running `offset()` ms ahead. Kept as source
 * text, not a function, because the renderer runs it too and the bundler adds
 * helper calls (name keeping) to a compiled function's `toString()`.
 */
const SHIFT_DATE = `(offset) => {
  const Real = Date
  const now = () => Real.now() + offset()
  globalThis.Date = new Proxy(Real, {
    apply: () => new Real(now()).toString(),
    construct: (target, args, newTarget) => Reflect.construct(target, args.length > 0 ? args : [now()], newTarget),
    get: (target, key, receiver) => (key === 'now' ? now : Reflect.get(target, key, receiver)),
  })
}`

let offset = 0
/** The unshifted clock. `pinClock` keeps the real `Date.now` here before it replaces `Date`. */
let realNow = () => Date.now()
let steps = 0

/** Pins main's clock to `PINNED_START`; called once at boot, before any module reads the time. */
export function pinClock(): void {
  const real = Date.now
  realNow = () => real()
  offset = PINNED_START - realNow()
  const shiftDate = new Function(`return ${SHIFT_DATE}`)() as (offset: () => number) => void
  shiftDate(() => offset)
}

/**
 * Restarts main's clock at `PINNED_START` and returns the same shift for the
 * renderer, to run before its scripts. The driver calls it right before it
 * reloads the page, so however long the boot took, both clocks start the run
 * at 15:00:00 and a slow boot can't roll a displayed minute.
 */
export function clockScript(): string {
  steps = 0
  offset = PINNED_START - realNow()
  return `(() => {
    let shift = ${offset}
    globalThis.__fidelityShift = (ms) => { shift = ms }
    ;(${SHIFT_DATE})(() => shift)
  })()`
}

/**
 * Sets main's clock to the next step's start, `PINNED_START` plus one minute per
 * step so far, and returns the script that does the same in the renderer. The
 * driver runs it as each step starts.
 */
export function startStep(): string {
  steps += 1
  offset = PINNED_START + steps * 60_000 - realNow()
  return `globalThis.__fidelityShift(${offset})`
}
