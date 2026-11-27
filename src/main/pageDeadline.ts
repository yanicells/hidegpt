import * as Effect from 'effect/Effect'

/** How long one page script, CDP command or capture may take before the walk gives up on the page. */
export const PAGE_TIMEOUT = '15 seconds'

/**
 * Waits for `ask`, a request to the page. A page that never answers (a hung or gone
 * renderer) dies with "The page did not answer in time: <what>" after `PAGE_TIMEOUT`,
 * so a screenshot walk can always quit. `onHang` runs first, for callers that stop
 * after the first hang.
 */
export const answered = <A>(what: string, ask: () => Promise<A>, onHang?: () => void) =>
  Effect.promise(ask).pipe(
    Effect.timeoutOrElse({
      duration: PAGE_TIMEOUT,
      orElse: () =>
        Effect.suspend(() => {
          onHang?.()
          return Effect.die(new Error(`The page did not answer in time: ${what}`))
        }),
    }),
  )
