/**
 * Fidelity captures pin the clock so "Opened 3:42 PM", recency groups and
 * suggestion timestamps read the same on every run. `Date` is shifted by a
 * constant, so time still moves and every deadline keeps its length.
 */

/** Monday 2 March 2026, 15:00 UTC: mid-afternoon, so the demo's "today" documents stay today. */
export const PINNED_START = Date.UTC(2026, 2, 2, 15, 0, 0)

/**
 * Replaces the global `Date` with one running `offset` ms ahead. Self-contained,
 * because the renderer gets it as source text (`clockScript`).
 */
function shiftDate(offset: number): void {
  const Real = Date
  const now = () => Real.now() + offset
  globalThis.Date = new Proxy(Real, {
    apply: () => new Real(now()).toString(),
    construct: (target, args, newTarget) => Reflect.construct(target, args.length > 0 ? args : [now()], newTarget),
    get: (target, key, receiver) => (key === 'now' ? now : Reflect.get(target, key, receiver)),
  })
}

let offset = 0

/** Pins main's clock to `PINNED_START`; called once at boot, before any module reads the time. */
export function pinClock(): void {
  offset = PINNED_START - Date.now()
  shiftDate(offset)
}

/** The same shift for the renderer, to run before its scripts. */
export const clockScript = (): string => `(${shiftDate.toString()})(${offset})`
