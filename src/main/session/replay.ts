// Adapted from T3 Code (apps/server/src/orchestration-v2/testkit/ProjectionReplay.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { FailureClass, ThreadEvent, TurnStatus } from '../../provider/events'
import { readLogLine } from '../logging/ProviderEventLog'
import type { ProviderId } from '../../shared/model'
import { adopt, applyThreadEvent, initialState, keyOf, type State, type ThreadRuntime } from './state'

/**
 * Folds an activity log (`logs/activity/<library>.ndjson`) back through the
 * same reducer the app runs, so "the document kept saying Working…" can be
 * reproduced without the provider. Like T3's projection replay, the log is
 * the source and the reducer is the projection.
 *
 * What the log cannot hold, the replay cannot show: text comes back as
 * placeholders of the right length, and what main does without an event
 * (the optimistic echo, "Stopping", the stop deadline, the items a document
 * opened with) is not in it. A turn starts at its `turn.started`.
 */

/** One turn as the page showed it: when it started working and how it stopped. */
export type ReplayedTurn = {
  readonly turnId: string
  readonly startedAt: string
  readonly endedAt: string | null
  /** Null while open. `reset` or `closed` when a reload or a removal ended it, not a terminal. */
  readonly status: TurnStatus | 'reset' | 'closed' | null
  readonly failure: FailureClass | null
}

export type ReplayedThread = {
  readonly provider: ProviderId
  readonly threadId: string
  readonly turns: ReadonlyArray<ReplayedTurn>
}

export type Replay = {
  readonly state: State
  /** In the order their first event appears. */
  readonly threads: ReadonlyArray<ReplayedThread>
  /** Lines folded into a thread. */
  readonly events: number
  /** Library events and lines that do not decode. */
  readonly skipped: number
}

/** How `event` ended the open turn, when it did. */
const endedBy = (event: ThreadEvent): Pick<ReplayedTurn, 'status' | 'failure'> => {
  if (event.type === 'turn.ended') return { status: event.status, failure: event.failure?.class ?? null }
  return { status: event.type === 'thread.closed' ? 'closed' : 'reset', failure: null }
}

/** A document the log talks about before anything opened it: an empty one, idle. */
const opened = (threadId: string) => ({
  threadId,
  title: '',
  items: [],
  olderCursor: null,
  cwd: '',
  activeTurnId: null,
})

export function replayEventLog(lines: Iterable<string>): Replay {
  let state = initialState('codex', () => '')
  const threads = new Map<string, { provider: ProviderId; threadId: string; turns: ReplayedTurn[] }>()
  let events = 0
  let skipped = 0
  for (const line of lines) {
    if (!line.trim()) continue
    const logged = readLogLine(line)
    if (!logged) {
      skipped += 1
      continue
    }
    const { provider, event, timestamp } = logged
    const at = Date.parse(timestamp)
    const key = keyOf(provider, event.threadId)
    if (!state.runtimes.has(key)) state = adopt(state, provider, opened(event.threadId), at)
    const before = state.runtimes.get(key)?.turn ?? null
    state = applyThreadEvent(state, provider, event, at)
    const after = state.runtimes.get(key)?.turn ?? null
    events += 1

    const thread = threads.get(key) ?? { provider, threadId: event.threadId, turns: [] }
    threads.set(key, thread)
    if (before?.id === after?.id) continue
    const open = thread.turns.at(-1)
    if (before && open && open.turnId === before.id && open.endedAt === null) {
      thread.turns[thread.turns.length - 1] = { ...open, endedAt: timestamp, ...endedBy(event) }
    }
    if (after) thread.turns.push({ turnId: after.id, startedAt: timestamp, endedAt: null, status: null, failure: null })
  }
  return { state, threads: [...threads.values()], events, skipped }
}

/** The replayed document, or undefined once the log closed it. */
export const replayedRuntime = (replay: Replay, provider: ProviderId, threadId: string): ThreadRuntime | undefined =>
  replay.state.runtimes.get(keyOf(provider, threadId))
