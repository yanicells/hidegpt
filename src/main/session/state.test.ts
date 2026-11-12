import { describe, expect, it } from 'vitest'

import type { ApprovalBlock, Block } from '../../shared/model'
import * as S from './state'

const approval = (id: string, resolved: ApprovalBlock['resolved'] = null): ApprovalBlock => ({
  kind: 'approval',
  id,
  suggestion: 'add',
  title: 'Run command?',
  body: 'ls',
  fields: [],
  questions: [],
  resolved,
})
const agent = (id: string, text: string): Block => ({ kind: 'agent', id, text })

const opened = (threadId: string, blocks: ReadonlyArray<Block> = [agent('a1', 'Hello.')]) => ({
  threadId,
  title: threadId,
  blocks,
  olderCursor: null,
  cwd: '/tmp/docs',
})

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

describe('session state', () => {
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
    const noAddress = { ...state.libraries.codex, catalog: { ...state.libraries.codex.catalog, account: { kind: 'chatgpt', label: 'ChatGPT' } as const } }
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

  it('puts a background library’s turn error on that library’s banner', () => {
    const state = S.applyThreadEvent(twoLibraries(), 'opencode', { type: 'turnEnded', threadId: 'ses_1', error: 'Rate limited.' }, 5)
    expect(state.libraries.opencode.error).toBe('Rate limited.')
    expect(state.libraries.codex.error).toBeNull()
    expect(runtime(state, 'opencode', 'ses_1')?.error).toBeNull()
  })

  it('keeps a hidden document’s turn error until it is opened', () => {
    let state = S.updateLibrary(twoLibraries(), 'codex', (lib) => ({ ...lib, route: { kind: 'home' } }))
    state = S.applyThreadEvent(state, 'codex', { type: 'turnEnded', threadId: 'thr_1', error: 'Rate limited.' }, 5)
    expect(state.libraries.codex.error).toBeNull()
    expect(runtime(state, 'codex', 'thr_1')?.error).toBe('Rate limited.')

    state = S.showThread(state, 'codex', 'thr_1')
    expect(state.libraries.codex.error).toBe('Rate limited.')
    expect(runtime(state, 'codex', 'thr_1')?.error).toBeNull()
  })

  it('on a crash, ends turns, skips open approvals, keeps the shown document and drops the rest', () => {
    let state = S.adopt(twoLibraries(), 'codex', opened('thr_2'), 0)
    state = S.applyThreadEvent(state, 'codex', { type: 'turnStarted', threadId: 'thr_1' }, 1)
    state = S.applyThreadEvent(state, 'codex', { type: 'block', threadId: 'thr_1', block: approval('ap_1') }, 2)
    state = S.connectionLost(state, 'codex', 'Codex stopped unexpectedly.')

    expect(runtime(state, 'codex', 'thr_1')).toMatchObject({ streaming: false, stale: true })
    expect(runtime(state, 'codex', 'thr_1')?.blocks.at(-1)).toMatchObject({ id: 'ap_1', resolved: 'skipped', pending: false })
    expect(runtime(state, 'codex', 'thr_2')).toBeUndefined()
    expect(runtime(state, 'opencode', 'ses_1')).toBeDefined()
    expect(state.libraries.codex).toMatchObject({ status: 'connecting', error: 'Codex stopped unexpectedly.' })
  })

  it('a reload or a reset keeps approvals that still wait for an answer', () => {
    let state = S.applyThreadEvent(twoLibraries(), 'codex', { type: 'block', threadId: 'thr_1', block: approval('ap_1') }, 1)
    state = S.applyThreadEvent(state, 'codex', { type: 'block', threadId: 'thr_1', block: approval('ap_0', 'accepted') }, 1)

    const reloaded = S.adopt(state, 'codex', opened('thr_1', [agent('a2', 'New.')]), 2)
    expect(runtime(reloaded, 'codex', 'thr_1')?.blocks.map((block) => block.id)).toEqual(['a2', 'ap_1'])

    const reset = S.applyThreadEvent(state, 'codex', { type: 'reset', threadId: 'thr_1', blocks: [agent('a3', 'Reset.')], streaming: true }, 3)
    expect(runtime(reset, 'codex', 'thr_1')).toMatchObject({ streaming: true })
    expect(runtime(reset, 'codex', 'thr_1')?.blocks.map((block) => block.id)).toEqual(['a3', 'ap_1'])
  })
})
