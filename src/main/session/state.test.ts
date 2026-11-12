import { describe, expect, it } from 'vitest'

import type { AssistantItem, Failure, Item, RequestItem, RequestStatus } from '../../provider/events'
import type { OpenedThread } from '../../provider/ProviderAdapter'
import { diffSnapshot } from '../../shared/snapshot-patch'
import * as S from './state'

const request = (id: string, status: RequestStatus = 'pending'): RequestItem => ({
  kind: 'request',
  id,
  request: 'command',
  status,
  subject: 'ls',
  detail: '',
  fields: [],
  questions: [],
})
const assistant = (id: string, text: string): AssistantItem => ({ kind: 'assistant', id, text, phase: 'final' })
const rateLimited: Failure = { class: 'usage_limit', detail: 'Rate limited.', retryable: false, resetAt: null }
const LIMIT_SENTENCE = 'You’ve reached your usage limit. Try again later.'

const opened = (
  threadId: string,
  items: ReadonlyArray<Item> = [assistant('a1', 'Hello.')],
  activeTurnId: string | null = null,
): OpenedThread => ({ threadId, title: threadId, items, olderCursor: null, cwd: '/tmp/docs', activeTurnId })

/** Codex active, showing `codexDoc`; OpenCode in the background, showing `openDoc`. */
const twoLibraries = () => {
  let state = S.initialState('opencode', () => '/tmp/docs')
  state = S.showThread(S.adopt(state, 'opencode', opened('ses_1'), 0), 'opencode', 'ses_1')
  state = { ...state, active: 'codex' }
  state = S.showThread(S.adopt(state, 'codex', opened('thr_1'), 0), 'codex', 'thr_1')
  return state
}

const runtime = (state: S.State, provider: 'codex' | 'opencode', threadId: string) =>
  state.runtimes.get(S.keyOf(provider, threadId))

/** `twoLibraries` with turn `turnId` sent and confirmed on codex's `thr_1`. */
const running = (turnId = 'turn-1') =>
  S.applyThreadEvent(twoLibraries(), 'codex', { type: 'turn.started', threadId: 'thr_1', turnId }, 1)

describe('session state', () => {
  it('drops a retrying notice once the turn streams again', () => {
    const notice: Item = { kind: 'notice', id: 'n1', notice: 'retrying', detail: null }
    let state = S.applyThreadEvent(
      running(),
      'codex',
      { type: 'item.upserted', threadId: 'thr_1', turnId: 'turn-1', item: notice },
      2,
    )
    expect(runtime(state, 'codex', 'thr_1')?.items.map((item) => item.id)).toEqual(['a1', 'n1'])
    state = S.applyThreadEvent(state, 'codex', { type: 'item.delta', threadId: 'thr_1', itemId: 'a1', delta: '!' }, 3)
    expect(runtime(state, 'codex', 'thr_1')?.items.map((item) => item.id)).toEqual(['a1'])
  })

  it('shows the signed-in address for a library that reports no account', () => {
    let state = S.initialState('opencode', () => '/tmp/docs')
    expect(S.toSnapshot(state).account).toBeNull()
    const account = { kind: 'chatgpt', label: 'yan@school.edu' } as const
    state = {
      ...state,
      libraries: {
        ...state.libraries,
        codex: { ...state.libraries.codex, catalog: { ...state.libraries.codex.catalog, account } },
      },
    }
    expect(S.toSnapshot(state).account).toBe(account)
    expect(S.toSnapshot({ ...state, active: 'claude' }).account).toBeNull()
    const noAddress = {
      ...state.libraries.codex,
      catalog: { ...state.libraries.codex.catalog, account: { kind: 'chatgpt', label: 'ChatGPT' } as const },
    }
    expect(S.toSnapshot({ ...state, libraries: { ...state.libraries, codex: noAddress } }).account).toBeNull()
  })

  it('keeps the document a background library shows, so switching back is not blank', () => {
    const state = twoLibraries()
    const idle = S.idleRuntimes(state, 2 * 60 * 60_000, 30 * 60_000, 12)
    expect(idle).toEqual([])
  })

  it('releases idle off-screen documents, oldest first past the cap', () => {
    let state = S.initialState('codex', () => '/tmp/docs')
    for (const [index, id] of ['thr_a', 'thr_b', 'thr_c'].entries()) state = S.adopt(state, 'codex', opened(id), index)
    expect(S.idleRuntimes(state, 10, 60_000, 1).map((item) => item.threadId)).toEqual(['thr_a', 'thr_b'])
    expect(S.idleRuntimes(state, 60_001, 60_000, 12).map((item) => item.threadId)).toEqual(['thr_a', 'thr_b'])
  })

  it('puts a background library’s failed turn on that library’s banner, in Docs’ words', () => {
    let state = S.applyThreadEvent(
      twoLibraries(),
      'opencode',
      { type: 'turn.started', threadId: 'ses_1', turnId: 't' },
      1,
    )
    state = S.applyThreadEvent(
      state,
      'opencode',
      { type: 'turn.ended', threadId: 'ses_1', turnId: 't', status: 'failed', failure: rateLimited },
      5,
    )
    expect(state.libraries.opencode.error).toBe(LIMIT_SENTENCE)
    expect(state.libraries.codex.error).toBeNull()
    expect(runtime(state, 'opencode', 'ses_1')?.error).toBeNull()
  })

  it('keeps a hidden document’s failed turn until it is opened', () => {
    let state = S.updateLibrary(running(), 'codex', (lib) => ({ ...lib, route: { kind: 'home' } }))
    state = S.applyThreadEvent(
      state,
      'codex',
      { type: 'turn.ended', threadId: 'thr_1', turnId: 'turn-1', status: 'failed', failure: rateLimited },
      5,
    )
    expect(state.libraries.codex.error).toBeNull()
    expect(runtime(state, 'codex', 'thr_1')?.error).toBe(LIMIT_SENTENCE)

    state = S.showThread(state, 'codex', 'thr_1')
    expect(state.libraries.codex.error).toBe(LIMIT_SENTENCE)
    expect(runtime(state, 'codex', 'thr_1')?.error).toBeNull()
  })

  it('ignores a terminal for any turn but the open one', () => {
    const state = running('turn-2')
    const late = S.applyThreadEvent(
      state,
      'codex',
      { type: 'turn.ended', threadId: 'thr_1', turnId: 'turn-1', status: 'failed', failure: rateLimited },
      5,
    )
    expect(late).toBe(state)
    expect(S.toSnapshot(late)).toMatchObject({ streaming: true, error: null })

    const own = S.applyThreadEvent(
      state,
      'codex',
      { type: 'turn.ended', threadId: 'thr_1', turnId: 'turn-2', status: 'completed', failure: null },
      6,
    )
    expect(S.toSnapshot(own).streaming).toBe(false)
  })

  it('keeps Stopping… through late deltas, until the stopped turn’s terminal', () => {
    let state = S.updateRuntime(running(), S.keyOf('codex', 'thr_1'), (item) => ({
      ...item,
      turn: { id: 'turn-1', phase: 'stopping' },
    }))
    state = S.applyThreadEvent(
      state,
      'codex',
      { type: 'item.delta', threadId: 'thr_1', itemId: 'a1', delta: ' More.' },
      2,
    )
    expect(S.toSnapshot(state)).toMatchObject({ streaming: true, stopping: true })
    // The settle timer of an older turn never ends this one.
    expect(S.settleStop(runtime(state, 'codex', 'thr_1')!, 'turn-0').turn).not.toBeNull()
    expect(S.settleStop(runtime(state, 'codex', 'thr_1')!, 'turn-1').turn).toBeNull()
  })

  it('shows a document opened mid-answer as streaming', () => {
    const state = S.showThread(S.adopt(twoLibraries(), 'codex', opened('thr_2', [], 'turn-9'), 0), 'codex', 'thr_2')
    expect(S.toSnapshot(state)).toMatchObject({ streaming: true, stopping: false })
    const ended = S.applyThreadEvent(
      state,
      'codex',
      { type: 'turn.ended', threadId: 'thr_2', turnId: 'turn-9', status: 'completed', failure: null },
      1,
    )
    expect(S.toSnapshot(ended).streaming).toBe(false)
  })

  it('a turn’s end expires the requests it left unanswered', () => {
    let state = S.applyThreadEvent(
      running(),
      'codex',
      { type: 'item.upserted', threadId: 'thr_1', turnId: 'turn-1', item: request('ap_1') },
      2,
    )
    state = S.applyThreadEvent(
      state,
      'codex',
      { type: 'turn.ended', threadId: 'thr_1', turnId: 'turn-1', status: 'interrupted', failure: null },
      3,
    )
    expect(runtime(state, 'codex', 'thr_1')?.items.at(-1)).toMatchObject({ id: 'ap_1', status: 'expired' })
    expect(S.toSnapshot(state).blocks.at(-1)).toMatchObject({ resolved: 'skipped', pending: false })
  })

  it('on a crash, ends turns, expires open requests, keeps the shown document and drops the rest', () => {
    let state = S.adopt(running(), 'codex', opened('thr_2'), 0)
    state = S.applyThreadEvent(
      state,
      'codex',
      { type: 'item.upserted', threadId: 'thr_1', turnId: 'turn-1', item: request('ap_1') },
      2,
    )
    state = S.connectionLost(state, 'codex', 'Docs lost its connection.')

    expect(runtime(state, 'codex', 'thr_1')).toMatchObject({ turn: null, stale: true })
    expect(runtime(state, 'codex', 'thr_1')?.items.at(-1)).toMatchObject({ id: 'ap_1', status: 'expired' })
    expect(runtime(state, 'codex', 'thr_2')).toBeUndefined()
    expect(runtime(state, 'opencode', 'ses_1')).toBeDefined()
    expect(state.libraries.codex).toMatchObject({ status: 'connecting', error: 'Docs lost its connection.' })
  })

  it('a reload or a reset keeps requests that still wait for an answer', () => {
    let state = S.applyThreadEvent(
      twoLibraries(),
      'codex',
      { type: 'item.upserted', threadId: 'thr_1', turnId: null, item: request('ap_1') },
      1,
    )
    state = S.applyThreadEvent(
      state,
      'codex',
      { type: 'item.upserted', threadId: 'thr_1', turnId: null, item: request('ap_0', 'accepted') },
      1,
    )

    const reloaded = S.adopt(state, 'codex', opened('thr_1', [assistant('a2', 'New.')]), 2)
    expect(runtime(reloaded, 'codex', 'thr_1')?.items.map((item) => item.id)).toEqual(['a2', 'ap_1'])

    const reset = S.applyThreadEvent(
      state,
      'codex',
      { type: 'thread.reset', threadId: 'thr_1', items: [assistant('a3', 'Reset.')], activeTurnId: 'turn-3' },
      3,
    )
    expect(S.toSnapshot(reset).streaming).toBe(true)
    expect(runtime(reset, 'codex', 'thr_1')?.items.map((item) => item.id)).toEqual(['a3', 'ap_1'])
  })

  it('a streamed delta crosses IPC as one append and nothing else', () => {
    const state = running()
    const before = S.toSnapshot(state)
    const after = S.toSnapshot(
      S.applyThreadEvent(state, 'codex', { type: 'item.delta', threadId: 'thr_1', itemId: 'a1', delta: ' World' }, 2),
    )
    expect(diffSnapshot(before, after)).toEqual({ fields: {}, blocks: { length: 1, append: [[0, ' World']] } })
  })
})
