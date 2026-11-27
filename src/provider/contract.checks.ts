// Adapted from T3 Code (https://github.com/pingdotgg/t3code), its replay fixtures, replay gate, testing strategy and
// provider traps, at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { expect } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import type { TurnId } from './events'
import { isThreadEvent, type AdapterEvent, type OpenedThread } from './ProviderAdapter'

/**
 * The judges of the adapter contract suite (`./contract.testkit.ts`): the stream checker every
 * scenario ends with, and the guard that holds a known gap to the failure it lists.
 */

/**
 * A scenario an adapter fails today, and why. The test passes only while the scenario fails as
 * listed, so a fixed gap turns red until its entry is deleted, and so does a gap that starts
 * failing for another reason (a driver timeout). Wave 3 (ARCH-4a/b/c) empties these lists.
 * - `fails`: text the failure message contains.
 * - `leaks` (`passthrough_*` only): every leaked `where: text` line, compared exactly, so a new
 *   leak in a source that already leaks still turns the test red. A leak can never pass as `fails`.
 */
export type KnownGap =
  | { readonly why: string; readonly fails: string }
  | { readonly why: string; readonly leaks: ReadonlyArray<string> }

/**
 * What a run with a `passthrough_*` scenario fails with, once its stream kept the contract: each
 * leaked `where: text` line, sorted. A gap's `leaks` lists them.
 */
export class Leaked extends Error {
  readonly lines: ReadonlyArray<string>
  constructor(lines: ReadonlyArray<string>) {
    super(['Provider text on the page:', ...lines].join('\n  '))
    this.lines = lines
  }
}

/**
 * The contract every event stream keeps, per thread: turns never overlap, each turn id
 * starts once and ends once, streaming happens inside a turn, an item stamped with a turn
 * names the open one, and every delta names an item already seen (or says how to create it).
 * An upsert stamped with no turn (history, a request settled after its turn) may come anywhere.
 */
export function contractViolations(events: ReadonlyArray<AdapterEvent>, opened: OpenedThread): string[] {
  const violations: string[] = []
  const open = new Map<string, TurnId>()
  const startedIds = new Set<string>()
  const endedIds = new Set<string>()
  const known = new Set(opened.items.map((item) => `${opened.threadId}/${item.id}`))
  if (opened.activeTurnId !== null) {
    open.set(opened.threadId, opened.activeTurnId)
    startedIds.add(opened.activeTurnId)
  }
  for (const event of events) {
    if (!isThreadEvent(event)) continue
    const current = open.get(event.threadId)
    switch (event.type) {
      case 'turn.started':
        if (startedIds.has(event.turnId)) violations.push(`${event.turnId} started twice`)
        if (current !== undefined) violations.push(`${event.turnId} started while ${current} was open`)
        startedIds.add(event.turnId)
        open.set(event.threadId, event.turnId)
        break
      case 'turn.ended':
        if (endedIds.has(event.turnId)) violations.push(`${event.turnId} ended twice`)
        else if (current !== event.turnId) violations.push(`${event.turnId} ended but ${current ?? 'no turn'} was open`)
        if ((event.status === 'failed') !== (event.failure !== null))
          violations.push(`${event.turnId} ended ${event.status} with failure ${JSON.stringify(event.failure)}`)
        endedIds.add(event.turnId)
        if (current === event.turnId) open.delete(event.threadId)
        break
      case 'item.upserted':
        if (event.turnId !== null && event.turnId !== current)
          violations.push(`${event.item.id} stamped ${event.turnId} while ${current ?? 'no turn'} was open`)
        known.add(`${event.threadId}/${event.item.id}`)
        break
      case 'item.delta':
        if (current === undefined) violations.push(`${event.itemId} streamed with no turn open`)
        if (!known.has(`${event.threadId}/${event.itemId}`) && !event.create)
          violations.push(`${event.itemId} streamed before it was announced`)
        known.add(`${event.threadId}/${event.itemId}`)
        break
      case 'thread.reset':
        for (const item of event.items) known.add(`${event.threadId}/${item.id}`)
        if (event.activeTurnId === null) open.delete(event.threadId)
        else {
          open.set(event.threadId, event.activeTurnId)
          startedIds.add(event.activeTurnId)
        }
        break
      case 'thread.renamed':
      case 'thread.closed':
        break
    }
  }
  for (const [threadId, turnId] of open) violations.push(`${turnId} on ${threadId} never ended`)
  return violations
}

/** The message a failed run failed with: an assertion, a timeout, or a provider error. */
export const failureMessage = (exit: Exit.Exit<unknown, unknown>): string | null => {
  if (Exit.isSuccess(exit)) return null
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

/** Passes while the scenario fails as the gap lists; says why when it does not. */
export const expectGap = (gap: KnownGap) => (exit: Exit.Exit<unknown, unknown>) =>
  Effect.sync(() => {
    const message = failureMessage(exit)
    if (message === null) throw new Error(`Passes now: delete this known gap (${gap.why})`)
    const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)
    if ('leaks' in gap) {
      if (!(error instanceof Leaked)) throw new Error(`Fails for another reason than its known leaks.\nGot: ${message}`)
      expect(error.lines, 'every leaked line, exactly').toEqual([...gap.leaks].sort())
    } else if (error instanceof Leaked) {
      throw new Error(`Leaks provider text: list every line as the gap's \`leaks\`.\nGot: ${message}`)
    } else if (!message.includes(gap.fails)) {
      throw new Error(`Fails for another reason than its known gap.\nExpected: ${gap.fails}\nGot: ${message}`)
    }
  })
