import { describe, expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Random from 'effect/Random'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import type { AdapterEvent, ProviderSession } from '../provider/ProviderAdapter'
import type * as CodexRpc from '../vendor/effect-codex-app-server/rpc.ts'
import * as CodexAdapter from './CodexAdapter'
import { BANNED_WORDS } from './mapping.ts'
import { agentItem, makeFakeCodex, rpcFailure, stubThread, stubTurn, userItem, type FakeCodex, type FakeCodexOptions } from './FakeCodex'

const SETTINGS = { model: null, effort: null, serviceTier: null, mode: null }

/** Opens a session against the in-process peer; events are collected as they arrive. */
const open = (options: FakeCodexOptions = {}) =>
  Effect.gen(function* () {
    const peer = makeFakeCodex(options)
    const session = yield* CodexAdapter.make(peer.connect).openSession
    const events: AdapterEvent[] = []
    yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(Effect.forkScoped)
    return { peer, session, events }
  })

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))

const send = (session: ProviderSession, text: string, clientId = 'local-1') =>
  session.send('thr_1', { text, images: [], skill: null, clientId }, SETTINGS)

/** Params of every request the client sent with `method`, in order. */
const paramsOf = (peer: FakeCodex, method: string) =>
  peer.calls.filter((call) => call.method === method).map((call) => call.params)

/** User blocks the adapter emitted, with the draft each one confirms. */
const userEchoes = (events: ReadonlyArray<AdapterEvent>) =>
  events.flatMap((event) => (event.type === 'block' && event.block.kind === 'user' ? [event] : []))

/** Id of the newest approval block, the handle `respond` takes. */
const approvalId = (events: ReadonlyArray<AdapterEvent>) => {
  const block = events.findLast((event) => event.type === 'block' && event.block.kind === 'approval')
  return block?.type === 'block' ? block.block.id : ''
}

/** Sends a server request, lets its block appear, answers it, and returns what Codex got back. */
const answerRequest = <M extends CodexRpc.ServerRequestMethod>(
  opened: { peer: FakeCodex; session: ProviderSession; events: AdapterEvent[] },
  method: M,
  params: CodexRpc.ServerRequestParamsByMethod[M],
  reply: { accept: boolean; answers: Record<string, string> },
) =>
  Effect.gen(function* () {
    const answer = yield* opened.peer.request(method, params).pipe(Effect.forkScoped)
    yield* settle
    yield* opened.session.respond('thr_1', approvalId(opened.events), reply)
    return yield* Fiber.join(answer)
  })

const HUMANIZER = { name: 'humanizer', description: '', path: '/tmp/skills/humanizer/SKILL.md' }

describe('CodexAdapter', () => {
  it.effect('loads the catalog and hides the Plan mode', () =>
    Effect.gen(function* () {
      const { session } = yield* open()
      const catalog = yield* session.loadCatalog
      expect(catalog.account).toEqual({ kind: 'chatgpt', label: 'student@school.edu' })
      expect(catalog.models.map((model) => model.id)).toEqual(['gpt-5.6-sol'])
      expect(catalog.modes).toEqual([{ id: 'Default', label: 'Default' }])
      expect(catalog.defaultMode).toBe('Default')
    }),
  )

  it.effect('streams a turn: echo confirmed by client id, deltas, then the final text', () =>
    Effect.gen(function* () {
      const { session, events } = yield* open({ reply: () => 'Hello there.' })
      yield* send(session, 'Hi')
      yield* settle
      const types = events.map((event) => event.type)
      expect(types[0]).toBe('turnStarted')
      expect(events[1]).toMatchObject({ type: 'block', replaces: 'local-1', block: { kind: 'user', text: 'Hi' } })
      const text = events.flatMap((event) => (event.type === 'text' ? [event.delta] : [])).join('')
      expect(text).toBe('Hello there.')
      expect(events.at(-2)).toMatchObject({ type: 'block', block: { kind: 'agent', text: 'Hello there.' } })
      expect(events.at(-1)).toEqual({ type: 'turnEnded', threadId: 'thr_1' })
    }),
  )

  it.effect('interrupts the running turn by its id', () =>
    Effect.gen(function* () {
      const { peer, session, events } = yield* open({ reply: null })
      yield* send(session, 'Long answer please')
      yield* settle
      yield* session.interrupt('thr_1')
      yield* settle
      const interrupt = peer.calls.find((call) => call.method === 'turn/interrupt')
      expect(interrupt?.params).toEqual({ threadId: 'thr_1', turnId: 'turn_1' })
      expect(events.at(-1)).toEqual({ type: 'turnEnded', threadId: 'thr_1' })
    }),
  )

  it.effect('holds an approval until the person answers, then replies with their decision', () =>
    Effect.gen(function* () {
      const { peer, session, events } = yield* open()
      const answer = yield* peer
        .request('item/commandExecution/requestApproval', {
          threadId: 'thr_1',
          turnId: 'turn_1',
          itemId: 'cmd_1',
          command: 'ls',
          startedAtMs: 1,
        })
        .pipe(Effect.forkScoped)
      yield* settle
      const block = events.find((event) => event.type === 'block')
      expect(block).toMatchObject({ block: { kind: 'approval', title: 'Run command?', body: 'ls' } })
      const blockId = block?.type === 'block' ? block.block.id : ''
      yield* session.respond('thr_1', blockId, { accept: true, answers: {} })
      expect(yield* Fiber.join(answer)).toEqual({ decision: 'accept' })
      const again = yield* Effect.exit(session.respond('thr_1', blockId, { accept: true, answers: {} }))
      expect(Exit.isFailure(again)).toBe(true)
    }),
  )

  it.effect('marks an approval skipped when Codex settles it first', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      yield* peer
        .request('item/fileChange/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'p_1', startedAtMs: 1 })
        .pipe(Effect.forkScoped)
      yield* settle
      const [requestId] = peer.pendingRequests()
      yield* peer.notify('serverRequest/resolved', { threadId: 'thr_1', requestId })
      yield* settle
      expect(events.at(-1)).toMatchObject({ type: 'resolved', threadId: 'thr_1', resolved: 'skipped' })
    }),
  )

  it.effect('fails a request that outlives its deadline with a timeout error', () =>
    Effect.gen(function* () {
      const { session } = yield* open({ handlers: { 'thread/resume': () => Effect.never } })
      const opening = yield* Effect.forkScoped(Effect.flip(session.openThread('thr_1')))
      yield* settle
      yield* TestClock.adjust('91 seconds')
      const error = yield* Fiber.join(opening)
      expect(error._tag).toBe('ProviderTimeoutError')
      expect(error.message).toBe('Codex did not answer in 90 s. Try again, or use Tools → Refresh.')
    }),
  )

  it.effect('reports a crash with the exit code and the stderr line', () =>
    Effect.gen(function* () {
      const { peer, session } = yield* open()
      const exited = yield* Effect.forkScoped(Effect.flip(session.awaitExit))
      yield* peer.exit(1, 'Error: config.toml is invalid')
      const error = yield* Fiber.join(exited)
      expect(error).toMatchObject({ _tag: 'ProcessExitedError', code: 1, stderr: 'Error: config.toml is invalid' })
    }),
  )

  it.effect('opening a document locked by another writer explains where it is open', () =>
    Effect.gen(function* () {
      const { session } = yield* open({
        handlers: { 'thread/resume': () => Effect.fail(rpcFailure('thread-store conflict: thr_1 already has an active writer')) },
      })
      const error = yield* Effect.flip(session.openThread('thr_1'))
      expect(error._tag).toBe('ProviderRequestError')
      expect(error.message).toBe('This document is open in another window. Close it there, then open it here.')
    }),
  )

  it.effect('opens a document with its recent turns in order, then loads older ones', () =>
    Effect.gen(function* () {
      const { peer, session } = yield* open({
        turns: [stubTurn('t-old', [userItem('u1', 'older question')]), stubTurn('t-new', [agentItem('a1', 'newer')])],
        olderTurns: [stubTurn('ancient', [userItem('u0', 'first question')])],
      })
      const opened = yield* session.openThread('thr_1')
      expect(paramsOf(peer, 'thread/resume')[0]).toMatchObject({
        threadId: 'thr_1',
        excludeTurns: true,
        initialTurnsPage: { sortDirection: 'desc', itemsView: 'full' },
      })
      expect(opened.blocks.map((block) => block.id)).toEqual(['u1', 'a1'])
      expect(opened.olderCursor).toBe('older')

      const older = yield* session.loadOlder('thr_1', 'older')
      expect(older.blocks).toEqual([{ kind: 'user', id: 'u0', text: 'first question' }])
      expect(older.cursor).toBeNull()
    }),
  )

  it.effect('shows only outputs: reasoning and plans stay off the page', () =>
    Effect.gen(function* () {
      const { peer, session, events } = yield* open({
        turns: [
          stubTurn('t1', [
            userItem('u1', 'explain this'),
            { type: 'reasoning', id: 'r1', summary: ['thinking'], content: ['deep thought'] },
            { type: 'plan', id: 'p1', text: 'my plan' },
            agentItem('a1', 'the answer'),
          ]),
        ],
      })
      const opened = yield* session.openThread('thr_1')
      expect(opened.blocks.map((block) => block.id)).toEqual(['u1', 'a1'])

      const item = { type: 'reasoning' as const, id: 'r2', summary: ['more'], content: [] }
      yield* peer.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item, completedAtMs: 1 })
      yield* settle
      expect(events).toEqual([])
    }),
  )

  it.effect('closing an idle document unsubscribes from it once', () =>
    Effect.gen(function* () {
      const { peer, session } = yield* open()
      yield* session.openThread('thr_1')
      yield* session.releaseThread('thr_1')
      yield* session.releaseThread('thr_1')
      expect(paramsOf(peer, 'thread/unsubscribe')).toEqual([{ threadId: 'thr_1' }])
    }),
  )

  it.effect('sends pasted images and a chosen skill as structured input', () =>
    Effect.gen(function* () {
      const { peer, session, events } = yield* open()
      yield* session.send(
        'thr_1',
        { text: 'make this sound like me', images: ['/tmp/a.png'], skill: HUMANIZER, clientId: 'local-1' },
        SETTINGS,
      )
      yield* settle
      expect(paramsOf(peer, 'turn/start')[0]).toMatchObject({
        clientUserMessageId: 'local-1',
        input: [
          { type: 'text', text: 'make this sound like me', text_elements: [] },
          { type: 'localImage', path: '/tmp/a.png' },
          { type: 'skill', name: 'humanizer', path: '/tmp/skills/humanizer/SKILL.md' },
        ],
      })
      expect(userEchoes(events)[0]).toMatchObject({
        replaces: 'local-1',
        block: { kind: 'user', text: 'make this sound like me', images: ['/tmp/a.png'], skills: ['humanizer'] },
      })
    }),
  )

  it.effect('sends an image-only message without an empty text part', () =>
    Effect.gen(function* () {
      const { peer, session } = yield* open()
      yield* session.send('thr_1', { text: '', images: ['/tmp/a.png'], skill: null, clientId: 'local-1' }, SETTINGS)
      expect(paramsOf(peer, 'turn/start')[0]).toMatchObject({ input: [{ type: 'localImage', path: '/tmp/a.png' }] })
    }),
  )

  it.effect('sends the chosen speed for each turn: a tier id, null for the default, unknown tiers as-is', () =>
    Effect.gen(function* () {
      const { peer, session } = yield* open()
      for (const serviceTier of ['fast', null, 'mystery-tier']) {
        yield* session.send('thr_1', { text: 'go', images: [], skill: null, clientId: `local-${serviceTier}` }, { ...SETTINGS, serviceTier })
        yield* settle
      }
      const tiers = paramsOf(peer, 'turn/start').map((params) => (params as { serviceTierForTurn?: unknown }).serviceTierForTurn)
      expect(tiers).toEqual(['fast', null, 'mystery-tier'])
    }),
  )

  it.effect('sends a chosen effort, and inherits the thread\'s effort for one Codex would reject', () =>
    Effect.gen(function* () {
      const { peer, session } = yield* open()
      const input = { text: 'Hi', images: [], skill: null, clientId: 'local-1' }
      yield* session.send('thr_1', input, { ...SETTINGS, effort: 'high' })
      yield* session.send('thr_1', { ...input, clientId: 'local-2' }, { ...SETTINGS, effort: '' })
      expect(paramsOf(peer, 'turn/start').map((params) => (params as { effort?: unknown }).effort)).toEqual(['high', null])
    }),
  )

  it.effect('draws message ids from Effect Random, so a seed pins them', () =>
    Effect.gen(function* () {
      const idWith = (seed: string) =>
        open().pipe(
          Effect.map(({ session }) => session.messageId()),
          Random.withSeed(seed),
        )
      const first = yield* idWith('pinned')
      expect(first).toMatch(/^local-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(yield* idWith('pinned')).toBe(first)
      expect(yield* idWith('other')).not.toBe(first)
    }),
  )

  it.effect('two identical messages each confirm their own draft', () =>
    Effect.gen(function* () {
      const { session, events } = yield* open()
      yield* send(session, 'same text', 'local-1')
      yield* settle
      yield* send(session, 'same text', 'local-2')
      yield* settle
      expect(userEchoes(events).map((event) => [event.replaces, event.block.id])).toEqual([
        ['local-1', 'user-turn_1'],
        ['local-2', 'user-turn_2'],
      ])
    }),
  )

  it.effect('a user message Codex did not tag with our id is added, not swapped for the draft', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      const item = userItem('u-server', 'different text')
      yield* peer.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item, startedAtMs: 1 })
      yield* settle
      expect(userEchoes(events)).toEqual([
        { type: 'block', threadId: 'thr_1', replaces: null, block: { kind: 'user', id: 'u-server', text: 'different text' } },
      ])
    }),
  )

  it.effect('a failed turn ends once, with the limit\'s reset time and no link', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      const resetsAt = 1_700_003_600
      yield* peer.notify('account/rateLimits/updated', {
        rateLimits: { limitId: 'codex', primary: { usedPercent: 100, resetsAt, windowDurationMins: 300 } },
      })
      const error = {
        message: 'You have hit your usage limit. Upgrade at https://chatgpt.com/pricing or try later.',
        codexErrorInfo: 'usageLimitExceeded' as const,
        additionalDetails: null,
        misalignment: null,
      }
      yield* peer.notify('error', { error, willRetry: false, threadId: 'thr_1', turnId: 'turn_1' })
      yield* peer.notify('turn/completed', { threadId: 'thr_1', turn: { ...stubTurn('turn_1', [], 'failed'), error } })
      yield* settle
      const at = new Date(resetsAt * 1000)
      const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
      expect(events).toEqual([{ type: 'turnEnded', threadId: 'thr_1', error: `Limit reached. Try again at ${time}.` }])
    }),
  )

  it.effect('a failure Docs has no sentence for ends the turn with a neutral one', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      const error = { message: 'Codex hit an internal model error', codexErrorInfo: 'other' as const, additionalDetails: null, misalignment: null }
      yield* peer.notify('turn/completed', { threadId: 'thr_1', turn: { ...stubTurn('turn_1', [], 'failed'), error } })
      yield* settle
      expect(events).toEqual([{ type: 'turnEnded', threadId: 'thr_1', error: 'Something went wrong. Try again.' }])
    }),
  )

  it.effect('a retry shows a notice until the answer resumes', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      const error = { message: 'Reconnecting… 1/5', codexErrorInfo: null, additionalDetails: null, misalignment: null }
      yield* peer.notify('error', { error, willRetry: true, threadId: 'thr_1', turnId: 'turn_1' })
      yield* settle
      expect(events).toEqual([{ type: 'notice', message: 'Reconnecting… 1/5' }])
      yield* peer.notify('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'a1', delta: 'Hi' })
      yield* peer.notify('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'a1', delta: '!' })
      yield* settle
      expect(events.filter((event) => event.type === 'clearNotice')).toEqual([{ type: 'clearNotice', message: 'Reconnecting… 1/5' }])
    }),
  )

  it.effect('a subagent\'s request shows in the document that started it, and Stop ends both turns', () =>
    Effect.gen(function* () {
      const opened = yield* open()
      const { peer, session, events } = opened
      const child = { ...stubThread('thr_child', ''), source: { subAgent: { thread_spawn: { parent_thread_id: 'thr_1', depth: 1 } } } }
      yield* peer.notify('thread/started', { thread: child })
      yield* peer.notify('turn/started', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'inProgress') })
      yield* peer.notify('turn/started', { threadId: 'thr_child', turn: stubTurn('turn_c', [], 'inProgress') })
      yield* peer.notify('item/agentMessage/delta', { threadId: 'thr_child', turnId: 'turn_c', itemId: 'c1', delta: 'notes' })
      const answer = yield* peer
        .request('item/commandExecution/requestApproval', {
          threadId: 'thr_child',
          turnId: 'turn_c',
          itemId: 'cmd_1',
          command: 'ls',
          startedAtMs: 1,
        })
        .pipe(Effect.forkScoped)
      yield* settle
      expect(events.map((event) => ('threadId' in event ? event.threadId : null))).toEqual(['thr_1', 'thr_1'])
      yield* session.respond('thr_1', approvalId(events), { accept: true, answers: {} })
      expect(yield* Fiber.join(answer)).toEqual({ decision: 'accept' })

      yield* session.interrupt('thr_1')
      expect(paramsOf(peer, 'turn/interrupt')).toEqual([
        { threadId: 'thr_1', turnId: 'turn_1' },
        { threadId: 'thr_child', turnId: 'turn_c' },
      ])
      yield* settle
      expect(events.filter((event) => event.type === 'turnEnded')).toEqual([{ type: 'turnEnded', threadId: 'thr_1' }])
    }),
  )

  it.effect('a subagent announced only by its activity item still belongs to the document', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      const item = { type: 'subAgentActivity' as const, id: 's1', agentPath: 'helper', agentThreadId: 'thr_child', kind: 'started' as const }
      yield* peer.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item, startedAtMs: 1 })
      yield* peer.notify('item/agentMessage/delta', { threadId: 'thr_child', turnId: 'turn_c', itemId: 'c1', delta: 'notes' })
      yield* peer
        .request('item/commandExecution/requestApproval', { threadId: 'thr_child', turnId: 'turn_c', itemId: 'cmd_1', command: 'ls', startedAtMs: 1 })
        .pipe(Effect.forkScoped)
      yield* settle
      expect(events).toMatchObject([{ type: 'block', threadId: 'thr_1', block: { kind: 'approval', title: 'Run command?' } }])
    }),
  )

  it.effect('a stopped document ends only after its subagent turns have', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      const item = { type: 'subAgentActivity' as const, id: 's1', agentPath: 'helper', agentThreadId: 'thr_child', kind: 'started' as const }
      yield* peer.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item, startedAtMs: 1 })
      yield* peer.notify('turn/started', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'inProgress') })
      yield* peer.notify('turn/started', { threadId: 'thr_child', turn: stubTurn('turn_c', [], 'inProgress') })
      yield* peer.notify('turn/completed', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'interrupted') })
      yield* settle
      expect(events.filter((event) => event.type === 'turnEnded')).toEqual([])
      yield* peer.notify('turn/completed', { threadId: 'thr_child', turn: stubTurn('turn_c', [], 'interrupted') })
      yield* settle
      expect(events.filter((event) => event.type === 'turnEnded')).toEqual([{ type: 'turnEnded', threadId: 'thr_1' }])
    }),
  )

  it.effect('a held end is dropped once the document starts its next turn', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      const item = { type: 'subAgentActivity' as const, id: 's1', agentPath: 'helper', agentThreadId: 'thr_child', kind: 'started' as const }
      yield* peer.notify('item/started', { threadId: 'thr_1', turnId: 'turn_1', item, startedAtMs: 1 })
      yield* peer.notify('turn/started', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'inProgress') })
      yield* peer.notify('turn/started', { threadId: 'thr_child', turn: stubTurn('turn_c', [], 'inProgress') })
      yield* peer.notify('turn/completed', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'interrupted') })
      // The person sends again before the subagent settles.
      yield* peer.notify('turn/started', { threadId: 'thr_1', turn: stubTurn('turn_2', [], 'inProgress') })
      yield* peer.notify('turn/completed', { threadId: 'thr_child', turn: stubTurn('turn_c', [], 'interrupted') })
      yield* settle
      const turnEvents = () => events.filter((event) => event.type === 'turnStarted' || event.type === 'turnEnded').map((event) => event.type)
      expect(turnEvents()).toEqual(['turnStarted', 'turnStarted'])
      yield* peer.notify('turn/completed', { threadId: 'thr_1', turn: stubTurn('turn_2', [], 'completed') })
      yield* settle
      expect(turnEvents()).toEqual(['turnStarted', 'turnStarted', 'turnEnded'])
    }),
  )

  it.effect('Stop still interrupts the other turns when one has already ended', () =>
    Effect.gen(function* () {
      const child = { ...stubThread('thr_child', ''), source: { subAgent: { thread_spawn: { parent_thread_id: 'thr_1', depth: 1 } } } }
      const { peer, session } = yield* open({
        handlers: {
          'turn/interrupt': (params) => (params.threadId === 'thr_child' ? Effect.fail(rpcFailure('no running turn')) : Effect.succeed({})),
        },
      })
      yield* peer.notify('thread/started', { thread: child })
      yield* peer.notify('turn/started', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'inProgress') })
      yield* peer.notify('turn/started', { threadId: 'thr_child', turn: stubTurn('turn_c', [], 'inProgress') })
      yield* settle
      yield* session.interrupt('thr_1')
      expect(paramsOf(peer, 'turn/interrupt')).toHaveLength(2)
    }),
  )

  it.effect('Stop fails when no turn could be interrupted', () =>
    Effect.gen(function* () {
      const { peer, session } = yield* open({ handlers: { 'turn/interrupt': () => Effect.fail(rpcFailure('no running turn')) } })
      yield* peer.notify('turn/started', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'inProgress') })
      yield* settle
      const exit = yield* Effect.exit(session.interrupt('thr_1'))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect('a reported error shows only on the failed turn it belongs to', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      const error = { message: 'stream lost', codexErrorInfo: 'other' as const, additionalDetails: null, misalignment: null }
      // Reported for turn_1, which still completes: no error.
      yield* peer.notify('error', { error, willRetry: false, threadId: 'thr_1', turnId: 'turn_1' })
      yield* peer.notify('turn/completed', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'completed') })
      // Reported for an earlier turn, then turn_2 fails on its own: not that earlier error.
      yield* peer.notify('error', { error, willRetry: false, threadId: 'thr_1', turnId: 'turn_0' })
      yield* peer.notify('turn/completed', { threadId: 'thr_1', turn: stubTurn('turn_2', [], 'failed') })
      yield* settle
      expect(events).toEqual([
        { type: 'turnEnded', threadId: 'thr_1' },
        { type: 'turnEnded', threadId: 'thr_1' },
      ])
    }),
  )

  it.effect('an error that arrives before its turn/started still ends that turn', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      yield* peer.notify('turn/started', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'inProgress') })
      yield* peer.notify('turn/completed', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'completed') })
      const error = { message: 'Unauthorized', codexErrorInfo: 'unauthorized' as const, additionalDetails: null, misalignment: null }
      yield* peer.notify('error', { error, willRetry: false, threadId: 'thr_1', turnId: 'turn_2' })
      yield* peer.notify('turn/started', { threadId: 'thr_1', turn: stubTurn('turn_2', [], 'inProgress') })
      yield* peer.notify('turn/completed', { threadId: 'thr_1', turn: stubTurn('turn_2', [], 'failed') })
      yield* settle
      expect(events.at(-1)).toEqual({ type: 'turnEnded', threadId: 'thr_1', error: 'Sign in again to continue.' })
    }),
  )

  it.effect('a late error for a finished turn does not replace the running turn\'s failure', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      const raw = { additionalDetails: null, misalignment: null }
      yield* peer.notify('turn/started', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'inProgress') })
      yield* peer.notify('error', {
        error: { ...raw, message: 'Unauthorized', codexErrorInfo: 'unauthorized' },
        willRetry: false,
        threadId: 'thr_1',
        turnId: 'turn_1',
      })
      yield* peer.notify('error', { error: { ...raw, message: 'old', codexErrorInfo: 'other' }, willRetry: false, threadId: 'thr_1', turnId: 'turn_0' })
      yield* peer.notify('turn/completed', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'failed') })
      yield* settle
      expect(events.at(-1)).toEqual({ type: 'turnEnded', threadId: 'thr_1', error: 'Sign in again to continue.' })
    }),
  )

  it.effect('a failed turn without its own error shows the error Codex reported for it', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      yield* peer.notify('turn/started', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'inProgress') })
      const error = { message: 'Unauthorized', codexErrorInfo: 'unauthorized' as const, additionalDetails: null, misalignment: null }
      yield* peer.notify('error', { error, willRetry: false, threadId: 'thr_1', turnId: 'turn_1' })
      yield* peer.notify('turn/completed', { threadId: 'thr_1', turn: stubTurn('turn_1', [], 'failed') })
      yield* settle
      expect(events.at(-1)).toEqual({ type: 'turnEnded', threadId: 'thr_1', error: 'Sign in again to continue.' })
    }),
  )

  it.effect('answers the current time and declines tools Docs does not host', () =>
    Effect.gen(function* () {
      const { peer } = yield* open()
      yield* TestClock.setTime(1_700_000_000_500)
      const time = yield* peer.request('currentTime/read', { threadId: 'thr_1' })
      expect(time).toEqual({ currentTimeAt: 1_700_000_000 })
      const tool = yield* peer.request('item/tool/call', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        callId: 'call_1',
        namespace: null,
        tool: 'calendar',
        arguments: {},
      })
      expect(tool).toMatchObject({ success: false })
    }),
  )

  it.effect('an MCP form sends back what the person typed when they accept', () =>
    Effect.gen(function* () {
      const opened = yield* open()
      const answer = yield* answerRequest(
        opened,
        'mcpServer/elicitation/request',
        {
          threadId: 'thr_1',
          turnId: 'turn_1',
          serverName: 'notion',
          mode: 'form',
          _meta: null,
          message: 'Connect Notion',
          requestedSchema: { type: 'object', properties: { workspace: { type: 'string', title: 'Workspace' } } },
        },
        { accept: true, answers: { workspace: 'eva' } },
      )
      expect(opened.events.find((event) => event.type === 'block')).toMatchObject({
        block: { kind: 'approval', title: 'Allow notion?', fields: [{ id: 'workspace', label: 'Workspace' }] },
      })
      expect(answer).toEqual({ action: 'accept', content: { workspace: 'eva' }, _meta: null })
      // T3 never touches Codex's elicitation counter; a leaked count pauses its timeouts.
      expect(opened.peer.calls.map((call) => call.method)).not.toContain('thread/increment_elicitation')
    }),
  )

  it.effect('a URL request is declined without opening anything or asking', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      const answer = yield* peer.request('mcpServer/elicitation/request', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        serverName: 'notion',
        mode: 'url',
        _meta: null,
        message: 'Sign in to Notion',
        url: 'https://example.test/oauth',
        elicitationId: 'el_1',
      })
      yield* settle
      expect(answer).toEqual({ action: 'decline', content: null, _meta: null })
      expect(events).toEqual([])
    }),
  )

  it.effect('an openai/form MCP request also sends back the typed answers', () =>
    Effect.gen(function* () {
      const opened = yield* open()
      const answer = yield* answerRequest(
        opened,
        'mcpServer/elicitation/request',
        {
          threadId: 'thr_1',
          turnId: 'turn_1',
          serverName: 'notion',
          mode: 'openai/form',
          _meta: null,
          message: 'Pick a workspace',
          requestedSchema: { type: 'object', properties: { workspace: { type: 'string', title: 'Workspace' } } },
        },
        { accept: true, answers: { workspace: 'eva' } },
      )
      expect(answer).toEqual({ action: 'accept', content: { workspace: 'eva' }, _meta: null })
    }),
  )

  it.effect('answers every question the assistant asked, even ones left blank', () =>
    Effect.gen(function* () {
      const opened = yield* open()
      const question = { header: '', isOther: false, isSecret: false }
      const answer = yield* answerRequest(
        opened,
        'item/tool/requestUserInput',
        {
          threadId: 'thr_1',
          turnId: 'turn_1',
          itemId: 'input_1',
          isBlocking: true,
          autoResolutionMs: null,
          questions: [
            { ...question, id: 'q1', question: 'Pick one', options: [{ label: 'A', description: '' }] },
            { ...question, id: 'q2', question: 'Anything else?', options: null },
          ],
        },
        { accept: true, answers: { q1: 'A' } },
      )
      expect(answer).toEqual({ answers: { q1: { answers: ['A'] }, q2: { answers: [] } } })
    }),
  )

  it.effect('declining a command or a file edit answers decline', () =>
    Effect.gen(function* () {
      const opened = yield* open()
      const no = { accept: false, answers: {} }
      const base = { threadId: 'thr_1', turnId: 'turn_1', startedAtMs: 1 }
      const command = yield* answerRequest(opened, 'item/commandExecution/requestApproval', { ...base, itemId: 'cmd_1', command: 'ls' }, no)
      const edit = yield* answerRequest(opened, 'item/fileChange/requestApproval', { ...base, itemId: 'patch_1', reason: 'edit files' }, no)
      expect([command, edit]).toEqual([{ decision: 'decline' }, { decision: 'decline' }])
    }),
  )

  it.effect('does not ask to sign in when Codex already has an account', () =>
    Effect.gen(function* () {
      const account = { type: 'chatgpt' as const, email: 'student@school.edu', planType: 'plus' as const }
      const signedIn = yield* open({ handlers: { 'account/read': () => Effect.succeed({ account, requiresOpenaiAuth: true }) } })
      expect((yield* signedIn.session.loadCatalog).requiresAuth).toBe(false)
      const signedOut = yield* open({ account: null })
      expect((yield* signedOut.session.loadCatalog).requiresAuth).toBe(true)
    }),
  )

  it.effect('a new project shows up in the catalog', () =>
    Effect.gen(function* () {
      const { peer, session } = yield* open()
      yield* session.createProject!('Course notes', '/tmp/course')
      expect(paramsOf(peer, 'project/create')[0]).toMatchObject({ idempotencyKey: expect.any(String) })
      const catalog = yield* session.loadCatalog
      expect(catalog.projects).toEqual([{ id: 'proj-0', name: 'Course notes', roots: [{ path: '/tmp/course' }] }])
    }),
  )

  it.effect('a new document is filed under the chosen project and folder', () =>
    Effect.gen(function* () {
      const { peer, session } = yield* open()
      const opened = yield* session.createThread({ cwd: '/tmp/course', projectId: 'course', title: null, settings: SETTINGS })
      expect(paramsOf(peer, 'thread/start')[0]).toMatchObject({ projectId: 'course', cwd: '/tmp/course' })
      expect(opened.cwd).toBe('/tmp/course')
    }),
  )

  it.effect('renaming a document saves the name in Codex', () =>
    Effect.gen(function* () {
      const { peer, session } = yield* open()
      yield* session.rename('thr_1', 'Lab report')
      expect(peer.threads.find((thread) => thread.id === 'thr_1')?.name).toBe('Lab report')
    }),
  )

  it.effect('lists the first page of documents before the rest arrive', () =>
    Effect.gen(function* () {
      const laterPages = yield* Deferred.make<void>()
      const { session } = yield* open({
        threads: Array.from({ length: 5 }, (_, index) => stubThread(`thr_${index}`, `Doc ${index}`)),
        threadPageSize: 2,
        before: (method, params) =>
          method === 'thread/list' && (params as { cursor: string | null }).cursor ? Deferred.await(laterPages) : Effect.void,
      })
      const seen: string[][] = []
      const listing = yield* Stream.runForEach(session.listDocs(''), (docs) =>
        Effect.sync(() => seen.push(docs.map((doc) => doc.id))),
      ).pipe(Effect.forkScoped)
      yield* settle
      expect(seen).toEqual([['thr_0', 'thr_1']])
      yield* Deferred.succeed(laterPages, undefined)
      yield* Fiber.join(listing)
      expect(seen.map((ids) => ids.length)).toEqual([2, 4, 5])
    }),
  )

  it.effect('nothing Docs shows names a provider, a model, or a link', () =>
    Effect.gen(function* () {
      const { peer, events } = yield* open()
      const item = (item: CodexRpc.ServerNotificationParamsByMethod['item/completed']['item']) =>
        peer.notify('item/completed', { threadId: 'thr_1', turnId: 'turn_1', item, completedAtMs: 1 })
      const ask = <M extends CodexRpc.ServerRequestMethod>(method: M, params: CodexRpc.ServerRequestParamsByMethod[M]) =>
        peer.request(method, params).pipe(Effect.forkScoped)
      const raw = { additionalDetails: null, misalignment: null }

      yield* peer.notify('error', {
        error: { ...raw, message: 'Codex is reconnecting to https://chatgpt.com, the model is busy 1/5', codexErrorInfo: null },
        willRetry: true,
        threadId: 'thr_1',
        turnId: 'turn_1',
      })
      yield* peer.notify('warning', { message: 'The gpt-5 model is deprecated, see https://openai.com/codex', threadId: 'thr_1' })
      yield* peer.notify('configWarning', { summary: 'Unknown key in your Codex config', details: null })
      yield* item({ type: 'mcpToolCall', id: 'm1', server: 'codex_apps', tool: 'chatgpt_search', status: 'completed', arguments: {} })
      yield* item({
        type: 'mcpToolCall',
        id: 'm2',
        server: 'mcp',
        tool: 'mcp__github__search',
        status: 'failed',
        arguments: {},
        error: { message: 'MCP error -32000: Connection closed' },
      })
      yield* peer.notify('warning', { message: 'HIDEGPT can not reach the LLMs or A.I. tools', threadId: 'thr_1' })
      yield* item({ type: 'dynamicToolCall', id: 'd1', tool: 'codex_helper', namespace: 'OpenAIAPI', status: 'completed', arguments: {} })
      yield* item({ type: 'dynamicToolCall', id: 'd2', tool: 'ChatGPTPlus', namespace: 'gpt5', status: 'completed', arguments: {} })
      yield* item({ type: 'functionCallOutput', id: 'f1', name: 'GPT4o_lookup', namespace: 'codexTools', output: '' })
      yield* item({
        type: 'collabAgentToolCall',
        id: 'c1',
        tool: 'spawnAgent',
        senderThreadId: 'thr_1',
        receiverThreadIds: ['thr_2'],
        status: 'completed',
        prompt: 'Research the topic',
        model: 'gpt-5',
        agentsStates: {},
      })
      yield* item({ type: 'contextCompaction', id: 'k1' })
      yield* ask('mcpServer/elicitation/request', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        serverName: 'codex_apps',
        mode: 'form',
        _meta: { connector_name: 'Notion' },
        message: 'Allow ChatGPT to use Notion?',
        requestedSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', title: 'API token' },
            server: { type: 'string', title: 'MCP server', enum: ['gpt5', 'local'], enumNames: ['Custom GPTs', 'Local'] },
          },
        },
      })
      yield* ask('item/tool/requestUserInput', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'i1',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: 'q1',
            header: '',
            isOther: false,
            isSecret: false,
            question: 'Which model should the subagent use?',
            options: [{ label: 'Claudes', description: '' }],
          },
        ],
      })
      yield* ask('item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'x1', command: 'ls', startedAtMs: 1 })
      yield* ask('item/fileChange/requestApproval', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'p1',
        reason: 'The provider SDK wants to edit files',
        startedAtMs: 1,
      })
      yield* ask('item/permissions/requestApproval', {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'q1',
        cwd: '/tmp',
        permissions: {},
        startedAtMs: 1,
      })
      yield* peer.notify('turn/completed', {
        threadId: 'thr_1',
        turn: {
          ...stubTurn('turn_1', [], 'failed'),
          error: { ...raw, message: 'You hit your ChatGPT usage limit, see https://chatgpt.com/codex', codexErrorInfo: 'usageLimitExceeded' },
        },
      })
      yield* settle

      // Everything a person could read, without the ids and internal tags.
      const hidden = new Set(['id', 'threadId', 'replaces', 'type', 'kind', 'command'])
      const visible = JSON.stringify(events, (key, value: unknown) => (hidden.has(key) ? undefined : value))
      const shown = visible
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([a-z])(\d)/gi, '$1 $2')
        .replace(/_/g, ' ')
      expect(events.some((event) => event.type === 'block' && event.block.kind === 'approval')).toBe(true)
      // The house list, shared with docsSafe, so a word missing there can't hide here.
      const banned = new RegExp(`\\b(?:${BANNED_WORDS.join('|')})(?:e?s)?\\b`, 'i')
      expect(visible).not.toMatch(banned)
      expect(shown).not.toMatch(banned)
      expect(visible).not.toMatch(/claude|codex|opencode|chatgpt|anthropic|openai|copilot|a\.i\./i)
      expect(shown).not.toMatch(/https?:|www\./i)
    }),
  )
})
