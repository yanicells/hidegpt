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
 * page, later rows ("Load earlier", new turns) render at once.
 */
export function useProgressiveRows(threadId: string, count: number): number {
  const [state, setState] = useState({ threadId, limit: FIRST_ROWS, done: false })
  // A different document opens progressively again.
  const current = state.threadId === threadId ? state : { threadId, limit: FIRST_ROWS, done: false }
  if (current !== state) setState(current)
  const done = current.done || current.limit >= count

  useEffect(() => {
    if (done) {
      if (!current.done) setState((previous) => ({ ...previous, done: true }))
      return
    }
    const step = setTimeout(() => setState((previous) => ({ ...previous, limit: previous.limit + ROWS_PER_STEP })), 0)
    return () => clearTimeout(step)
  }, [done, current.done, current.limit])

  return done ? count : current.limit
}
