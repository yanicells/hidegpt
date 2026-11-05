import { useEffect, useState } from 'react'

// Enough rows to fill the first screen of a freshly opened document.
const FIRST_ROWS = 12
// Rows added per task afterwards: about 10 ms of rendering each.
const ROWS_PER_STEP = 12

/**
 * How many of a document's rows to render. Opening renders the first screen
 * at once and adds the rest a step per task, so a long document never blocks
 * input while it opens (snapshot updates render synchronously, and a
 * transition would starve while an answer streams). Once every row is on the
 * page, later rows ("Load earlier", new turns) render at once. The document
 * mounts once per thread, so each opens progressively.
 */
export function useProgressiveRows(count: number): number {
  const [state, setState] = useState({ limit: FIRST_ROWS, done: false })
  const done = state.done || state.limit >= count

  useEffect(() => {
    if (done) {
      if (!state.done) setState((previous) => ({ ...previous, done: true }))
      return
    }
    const step = setTimeout(() => setState((previous) => ({ ...previous, limit: previous.limit + ROWS_PER_STEP })), 0)
    return () => clearTimeout(step)
  }, [done, state.done, state.limit])

  return done ? count : state.limit
}
