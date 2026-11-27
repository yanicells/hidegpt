import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

// Enough rows to fill the first screen of a freshly opened document.
const FIRST_ROWS = 12
// Rows added by the first step after the first screen.
const FIRST_STEP = 12
// A step that rendered in under FAST_MS doubles the next one; one over SLOW_MS halves it.
const FAST_MS = 8
const SLOW_MS = 16

// Sizes the next step from how long the previous one took, so each stays within a frame.
function nextStep(step: number, ms: number): number {
  if (ms < FAST_MS) return step * 2
  if (ms > SLOW_MS) return Math.max(1, Math.floor(step / 2))
  return step
}

/**
 * How many of a document's rows to render. Opening renders the first screen
 * at once and adds the rest a step per task, so a long document never blocks
 * input while it opens (snapshot updates render synchronously, and a
 * transition would starve while an answer streams). Each step is timed and
 * the next one sized from it, so a fast machine opens in a few commits.
 * Steps run as MessageChannel tasks: nested timers are clamped to 4 ms.
 * Once every row is on the page, later rows ("Load earlier", new turns)
 * render at once. The document mounts once per thread, so each opens
 * progressively and a thread change closes the pending step's channel.
 */
export function useProgressiveRows(count: number): number {
  const [state, setState] = useState(() => ({ limit: FIRST_ROWS, done: count <= FIRST_ROWS }))
  const step = useRef(FIRST_STEP)
  const done = state.done || state.limit >= count

  useEffect(() => {
    if (done) {
      // Only when rows were removed mid-open: the last step latches `done` itself.
      // oxlint-disable-next-line react/set-state-in-effect -- latches `done` once every row is on the page
      if (!state.done) setState((previous) => ({ ...previous, done: true }))
      return
    }
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      const started = performance.now()
      // Rendered here rather than in a later scheduler task, so the time is the step's own.
      flushSync(() =>
        setState((previous) => {
          const limit = previous.limit + step.current
          return { limit, done: limit >= count }
        }),
      )
      step.current = nextStep(step.current, performance.now() - started)
    }
    channel.port2.postMessage(null)
    // A message already queued finds no handler, so nothing runs after unmount.
    return () => {
      channel.port1.onmessage = null
      channel.port1.close()
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each new limit schedules the next step
  }, [count, done, state.done, state.limit])

  return done ? count : state.limit
}
