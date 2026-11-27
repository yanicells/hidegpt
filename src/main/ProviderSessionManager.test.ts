import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Logger from 'effect/Logger'
import * as Option from 'effect/Option'
import * as References from 'effect/References'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import * as ClaudeAdapter from '../claude/ClaudeAdapter'
import { makeFakeClaude } from '../claude/FakeClaude'
import * as CodexAdapter from '../codex/CodexAdapter'
import { agentItem, makeFakeCodex, rpcFailure, stubTurn, userItem, type FakeCodexOptions } from '../codex/FakeCodex'
import { describeFailure } from '../provider/DefectReport'
import { ProviderTimeoutError } from '../provider/errors'
import { fromLegacy, type LegacyProviderAdapter } from '../provider/legacyEvents'
import type { Snapshot } from '../shared/model'
import { layerAdapters, layerLoaders } from './ProviderRegistry'
import * as Manager from './ProviderSessionManager'
import { STOP_FAILED } from './session/TurnController'

/**
 * The session manager over the real Codex adapter and the in-process Codex
 * peer: only the process boundary is fake, so these cover the same paths the
 * app runs (T3 Code's replay-fixture approach).
 */
const setup = (options: FakeCodexOptions = {}, others: { claude?: LegacyProviderAdapter } = {}) =>
  Effect.gen(function* () {
    const peer = makeFakeCodex(options)
    const opened: string[] = []
    const manager = yield* Manager.make({
      defaultCwd: () => '/tmp/docs',
      openExternal: (url) => Effect.sync(() => opened.push(url)),
    }).pipe(
      Effect.provide(
        layerAdapters({
          codex: fromLegacy(CodexAdapter.make(peer.connect)),
          ...(others.claude ? { claude: fromLegacy(others.claude) } : {}),
        }),
      ),
    )
    yield* manager.start('codex')
    yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
    return { peer, manager, opened }
  })

type Service = Manager.ProviderSessionManager['Service']

/** The first snapshot that matches. */
const until = (manager: Service, predicate: (snapshot: Snapshot) => boolean) =>
  manager.snapshots.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))

/** Error-level logs (their cause and annotations), instead of the console. */
const captureErrorLogs = () => {
  const logged: Array<{ readonly cause: string; readonly annotations: Record<string, unknown> }> = []
  const capture = Logger.make(({ cause, fiber, logLevel }) => {
    if (logLevel === 'Error')
      logged.push({ cause: Cause.pretty(cause), annotations: fiber.getRef(References.CurrentLogAnnotations) })
  })
  return { logged, layer: Logger.layer([capture]) }
}

/** Warnings (their message and annotations), instead of the console. */
const captureWarnings = () => {
  const logged: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
  const capture = Logger.make(({ message, fiber, logLevel }) => {
    if (logLevel === 'Warn') logged.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) })
  })
  return { logged, layer: Logger.layer([capture]) }
}

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 30 }))

/** A Codex document's target, for commands that name their document. */
const doc = (threadId: string) => ({ provider: 'codex', threadId }) as const

/** A copy of `params` whose `key` throws when read: a Docs mapping bug, which the fake's schema-checked frames cannot produce. */
const throwingOn = <T extends object>(params: T, key: string, message: string): T =>
  Object.defineProperty({ ...params }, key, {
    get: () => {
      throw new Error(message)
    },
  })

/** Codex over `peer`, where the first `method` message (a notification or a request) reaches Docs with a throwing `key`. */
const brokenOnce = (peer: ReturnType<typeof makeFakeCodex>, method: string, key: string, message: string) => {
  let broken = true
  const poison = <T extends object>(name: string, params: T) =>
    name === method && broken ? ((broken = false), throwingOn(params, key, message)) : params
  return fromLegacy(
    CodexAdapter.make(
      Effect.map(peer.connect, (client): CodexAdapter.Client => ({
        ...client,
        handleServerNotification: (name, handler) =>
          client.handleServerNotification(name, (params) => handler(poison(name, params))),
        handleServerRequest: (name, handler) =>
          client.handleServerRequest(name, (params) => handler(poison(name, params))),
      })),
    ),
  )
}
const countCalls = (peer: { calls: ReadonlyArray<{ method: string }> }, method: string) =>
  peer.calls.filter((call) => call.method === method).length

describe('ProviderSessionManager', () => {
  it.effect('keeps a turn streaming while the window is on Home, and reopens it instantly', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup({ reply: () => 'Chlorophyll absorbs light.', deltaDelayMs: 100 })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', provider: 'codex', threadId: 'thr_1', text: 'Why are leaves green?' })
      yield* manager.dispatch({ op: 'goHome' })
      yield* TestClock.adjust('1 second')
      yield* settle

      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      const shown = yield* manager.snapshot
      expect(shown.route).toEqual({ kind: 'doc', threadId: 'thr_1' })
      expect(shown.streaming).toBe(false)
      expect(shown.blocks.map((block) => block.kind)).toEqual(['user', 'agent'])
      expect(shown.blocks[1]).toMatchObject({ text: 'Chlorophyll absorbs light.' })
      expect(countCalls(peer, 'thread/resume')).toBe(1)
    }),
  )

  it.effect('holds an approval that arrives off-screen until the person answers it', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup()
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'goHome' })
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

      // Hours on Home do not release a document with a question waiting.
      yield* TestClock.adjust('2 hours')
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      const approval = (yield* manager.snapshot).blocks.find((block) => block.kind === 'approval')
      expect(approval).toMatchObject({ title: 'Run command?', body: 'ls', resolved: null })

      yield* manager.dispatch({
        op: 'resolveApproval',
        provider: 'codex',
        threadId: 'thr_1',
        blockId: approval?.id ?? '',
        accept: true,
      })
      expect(yield* Fiber.join(answer)).toEqual({ decision: 'accept' })
      expect((yield* manager.snapshot).blocks.find((block) => block.kind === 'approval')).toMatchObject({
        resolved: 'accepted',
        pending: false,
      })
    }),
  )

  it.effect('shows Stopping until the turn really ends', () =>
    Effect.gen(function* () {
      const { manager } = yield* setup({ reply: null })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', provider: 'codex', threadId: 'thr_1', text: 'Write a long essay' })
      yield* until(manager, (snapshot) =>
        snapshot.blocks.some((block) => block.kind === 'user' && !block.id.startsWith('local-')),
      )
      const stopping = yield* Effect.forkScoped(until(manager, (snapshot) => snapshot.stopping))
      yield* manager.dispatch({ op: 'interrupt', provider: 'codex', threadId: 'thr_1' })
      expect(yield* Fiber.join(stopping)).toMatchObject({ streaming: true, stopping: true })
      const ended = yield* until(manager, (snapshot) => !snapshot.streaming)
      expect(ended.stopping).toBe(false)
    }),
  )

  it.effect('a stop from before a crash does not end a turn sent after the reconnect', () =>
    Effect.gen(function* () {
      // The stop is never answered, and the crash ends the stopped turn without a turnEnded.
      const { peer, manager } = yield* setup({ reply: null, handlers: { 'turn/interrupt': () => Effect.never } })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', provider: 'codex', threadId: 'thr_1', text: 'First' })
      yield* until(
        manager,
        (snapshot) =>
          snapshot.streaming &&
          snapshot.blocks.some((block) => block.kind === 'user' && !block.id.startsWith('local-')),
      )
      yield* Effect.forkScoped(manager.dispatch({ op: 'interrupt', provider: 'codex', threadId: 'thr_1' }))
      yield* until(manager, (snapshot) => snapshot.stopping)
      yield* peer.exit(1, 'boom')
      yield* until(manager, (snapshot) => snapshot.status === 'connecting')
      yield* TestClock.adjust('1 second')
      yield* until(manager, (snapshot) => snapshot.status === 'ready')
      yield* settle
      yield* manager.dispatch({ op: 'send', provider: 'codex', threadId: 'thr_1', text: 'Second' })
      yield* until(manager, (snapshot) => snapshot.streaming && !snapshot.stopping)
      yield* TestClock.adjust('10 seconds')
      yield* settle
      expect((yield* manager.snapshot).streaming).toBe(true)
    }),
  )

  it.effect('a stop timer from an earlier turn does not keep the next stop from settling', () =>
    Effect.gen(function* () {
      // The first stop is confirmed at once; the second is never answered.
      let interrupts = 0
      const { peer, manager } = yield* setup({
        reply: null,
        handlers: {
          'turn/interrupt': (params): Effect.Effect<Record<string, never>> =>
            (interrupts += 1) === 1
              ? peer
                  .notify('turn/completed', {
                    threadId: params.threadId,
                    turn: { id: params.turnId, items: [], status: 'interrupted' },
                  })
                  .pipe(Effect.as({}))
              : Effect.never,
        },
      })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      const stopTurn = Effect.gen(function* () {
        yield* until(manager, (snapshot) => snapshot.streaming && !snapshot.stopping)
        yield* Effect.forkScoped(manager.dispatch({ op: 'interrupt', ...doc('thr_1') }))
        yield* until(manager, (snapshot) => snapshot.stopping)
      })
      yield* manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'First' })
      yield* stopTurn
      yield* until(manager, (snapshot) => !snapshot.streaming)
      yield* manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Second' })
      yield* stopTurn
      yield* TestClock.adjust('10 seconds')
      yield* settle
      expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false })
    }),
  )

  it.effect('an approval reply that lands after its turn ended leaves the request expired', () =>
    Effect.gen(function* () {
      const peer = makeFakeCodex({ reply: null })
      const replyGate = yield* Deferred.make<void>()
      const codex = fromLegacy(CodexAdapter.make(peer.connect))
      const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
        Effect.provide(
          layerAdapters({
            codex: {
              ...codex,
              // The reply is slow to reach the provider.
              openSession: Effect.map(codex.openSession, (session) => ({
                ...session,
                respond: (...args) => Deferred.await(replyGate).pipe(Effect.andThen(session.respond(...args))),
              })),
            },
          }),
        ),
      )
      yield* manager.start('codex')
      yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'List the files' })
      yield* until(manager, (snapshot) => snapshot.streaming)
      yield* peer
        .request('item/commandExecution/requestApproval', {
          threadId: 'thr_1',
          turnId: 'turn_1',
          itemId: 'cmd_1',
          command: 'ls',
          startedAtMs: 1,
        })
        .pipe(Effect.ignore, Effect.forkScoped)
      const asked = yield* until(manager, (snapshot) => snapshot.blocks.some((block) => block.kind === 'approval'))
      const blockId = asked.blocks.find((block) => block.kind === 'approval')?.id ?? ''

      const replying = yield* Effect.forkScoped(
        manager.dispatch({ op: 'resolveApproval', ...doc('thr_1'), blockId, accept: true }),
      )
      yield* until(manager, (snapshot) => snapshot.blocks.some((block) => block.kind === 'approval' && block.pending))
      // The turn ends while the reply is on its way, which expires the request.
      yield* manager.dispatch({ op: 'interrupt', ...doc('thr_1') })
      yield* until(manager, (snapshot) => !snapshot.streaming)
      yield* Deferred.succeed(replyGate, undefined)
      yield* Fiber.join(replying)
      expect((yield* manager.snapshot).blocks.find((block) => block.kind === 'approval')).toMatchObject({
        resolved: 'skipped',
        pending: false,
      })
    }),
  )

  it.effect('loads older turns in the same snapshot that ends loading', () =>
    Effect.gen(function* () {
      const { manager } = yield* setup({
        turns: [stubTurn('t1', [userItem('u1', 'Recent'), agentItem('a1', 'Answer.')])],
        olderTurns: [stubTurn('t0', [userItem('u0', 'First')])],
      })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* until(manager, (snapshot) => snapshot.hasOlder && snapshot.blocks.length === 2)
      // The window restores your place when loading ends, so the blocks must already be there.
      const loaded = yield* Effect.forkScoped(
        manager.snapshots.pipe(
          Stream.dropWhile((snapshot) => !snapshot.loadingOlder),
          Stream.filter((snapshot) => !snapshot.loadingOlder),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        ),
      )
      yield* settle
      yield* manager.dispatch({ op: 'loadOlderTurns', provider: 'codex', threadId: 'thr_1' })
      const done = yield* Fiber.join(loaded)
      expect(done.blocks.map((block) => block.id)).toEqual(['u0', 'u1', 'a1'])
      expect(done.hasOlder).toBe(false)
    }),
  )

  it.effect('a send the provider refuses frees the document and drops the echo', () =>
    Effect.gen(function* () {
      const { manager } = yield* setup({ handlers: { 'turn/start': () => Effect.fail(rpcFailure('busy')) } })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      const before = (yield* manager.snapshot).blocks
      yield* Effect.flip(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Hi' }))
      expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false, blocks: before })
    }),
  )

  it.effect('refuses an empty send so the composer keeps the draft', () =>
    Effect.gen(function* () {
      const { manager } = yield* setup()
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      const error = yield* Effect.flip(
        manager.dispatch({ op: 'send', provider: 'codex', threadId: 'thr_1', text: '   ' }),
      )
      expect(error.message).toBe('There is nothing to send.')
    }),
  )

  it.effect('files a new document where the renderer says, else in the default place, never beside the open one', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup()
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'newDocument', projectId: null })
      yield* manager.dispatch({ op: 'newDocument', projectId: 'course', cwd: '/tmp/course' })
      const cwds = peer.calls
        .filter((call) => call.method === 'thread/start')
        .map((call) => (call.params as { cwd?: string }).cwd)
      expect(cwds).toEqual(['/tmp/docs', '/tmp/course'])
    }),
  )

  it.effect('a newer open wins over a slower one', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const { manager } = yield* setup({
        before: (method, params) =>
          method === 'thread/resume' && (params as { threadId: string }).threadId === 'thr_1'
            ? Deferred.await(gate)
            : Effect.void,
      })
      const slow = yield* Effect.forkScoped(manager.dispatch({ op: 'openThread', threadId: 'thr_1' }))
      yield* settle
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_2' })
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(slow)
      yield* settle
      const snapshot = yield* manager.snapshot
      expect(snapshot).toMatchObject({
        route: { kind: 'doc', threadId: 'thr_2' },
        title: 'Chem lab',
        openingThreadId: null,
      })
    }),
  )

  it.effect('restarts Codex after a crash and reloads the open document', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup({
        turns: [stubTurn('turn_0', [userItem('u0', 'Hi'), agentItem('a0', 'Hello.')])],
      })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* peer.exit(1, 'Error: config.toml is invalid')
      const lost = yield* until(manager, (snapshot) => snapshot.status === 'connecting')
      expect(lost.error).toBe(
        'Codex stopped unexpectedly (exit 1): Error: config.toml is invalid. Docs is reconnecting.',
      )
      expect(lost.blocks).toHaveLength(2)

      yield* TestClock.adjust('1 second')
      const back = yield* until(manager, (snapshot) => snapshot.status === 'ready')
      expect(back.error).toBeNull()
      expect(peer.connections()).toBe(2)
      yield* settle
      expect(countCalls(peer, 'thread/resume')).toBe(2)
      expect((yield* manager.snapshot).route).toEqual({ kind: 'doc', threadId: 'thr_1' })
    }),
  )

  it.effect('a request past its deadline fails the command without restarting Codex', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup({ handlers: { 'thread/resume': () => Effect.never } })
      const opening = yield* Effect.forkScoped(Effect.flip(manager.dispatch({ op: 'openThread', threadId: 'thr_1' })))
      yield* settle
      expect((yield* manager.snapshot).openingThreadId).toBe('thr_1')
      yield* TestClock.adjust('91 seconds')
      const error = yield* Fiber.join(opening)
      expect(error._tag).toBe('ProviderTimeoutError')
      const snapshot = yield* manager.snapshot
      expect(snapshot).toMatchObject({ openingThreadId: null, status: 'ready', route: { kind: 'home' } })
      expect(snapshot.error).toBe(error.message)
      expect(peer.connections()).toBe(1)
    }),
  )

  it.effect('releases a document left idle off-screen', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup()
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'goHome' })
      expect(yield* manager.runtimeCount).toBe(1)
      yield* TestClock.adjust('31 minutes')
      yield* settle
      expect(yield* manager.runtimeCount).toBe(0)
      expect(countCalls(peer, 'thread/unsubscribe')).toBe(1)
    }),
  )

  it.effect('logs a defect in the skills refresh an open starts, which nobody waits on', () => {
    const { logged, layer } = captureErrorLogs()
    return Effect.gen(function* () {
      const peer = makeFakeCodex()
      const codex = CodexAdapter.make(peer.connect)
      let armed = false
      const flaky: LegacyProviderAdapter = {
        ...codex,
        openSession: Effect.map(codex.openSession, (session) => ({
          ...session,
          listSkills: (cwd: string) => (armed ? Effect.die(new Error('skills bug')) : session.listSkills(cwd)),
        })),
      }
      const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
        Effect.provide(layerAdapters({ codex: fromLegacy(flaky) })),
      )
      yield* manager.start('codex')
      yield* until(manager, (snapshot) => snapshot.status === 'ready')
      yield* settle
      armed = true
      // Opening a document refreshes the skills of its folder.
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* settle
      // So does choosing a folder on Home.
      yield* manager.dispatch({ op: 'goHome' })
      yield* manager.setFolder('/tmp/elsewhere')
      yield* settle
      const report = {
        cause: expect.stringContaining('skills bug'),
        annotations: expect.objectContaining({ reportId: expect.any(String) }),
      }
      expect(logged).toEqual([report, report])
    }).pipe(Effect.provide(layer))
  })

  it.effect('keeps sweeping idle documents after one release hits a defect, and logs it', () => {
    const { logged, layer } = captureErrorLogs()
    return Effect.gen(function* () {
      const peer = makeFakeCodex()
      const codex = CodexAdapter.make(peer.connect)
      let broken = true
      const flaky: LegacyProviderAdapter = {
        ...codex,
        openSession: Effect.map(codex.openSession, (session) => ({
          ...session,
          releaseThread: (threadId: string) =>
            broken ? ((broken = false), Effect.die(new Error('release bug'))) : session.releaseThread(threadId),
        })),
      }
      const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
        Effect.provide(layerAdapters({ codex: fromLegacy(flaky) })),
      )
      yield* manager.start('codex')
      yield* until(manager, (snapshot) => snapshot.status === 'ready')
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'goHome' })
      yield* TestClock.adjust('31 minutes')
      yield* settle
      expect(logged).toEqual([
        {
          cause: expect.stringContaining('release bug'),
          annotations: expect.objectContaining({ reportId: expect.any(String) }),
        },
      ])

      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_2' })
      yield* manager.dispatch({ op: 'goHome' })
      yield* TestClock.adjust('31 minutes')
      yield* settle
      expect(yield* manager.runtimeCount).toBe(0)
      expect(countCalls(peer, 'thread/unsubscribe')).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect('keeps each library’s document and account across a switch, and never releases the one it shows', () =>
    Effect.gen(function* () {
      const claude = makeFakeClaude()
      const { manager } = yield* setup({}, { claude: ClaudeAdapter.make(() => Promise.resolve(claude.sdk)) })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'setProvider', provider: 'claude' })
      const other = yield* until(manager, (snapshot) => snapshot.provider === 'claude' && snapshot.account !== null)
      expect(other.account?.label).toBe('student@example.edu')
      expect(other.route).toEqual({ kind: 'home' })

      // Hours in the other library: the Codex document is still what Codex shows.
      yield* TestClock.adjust('2 hours')
      yield* settle
      yield* manager.dispatch({ op: 'setProvider', provider: 'codex' })
      const back = yield* manager.snapshot
      expect(back).toMatchObject({
        provider: 'codex',
        route: { kind: 'doc', threadId: 'thr_1' },
        title: 'Photosynthesis',
      })
      expect(back.account?.label).toMatch(/student@school\.edu/)
    }),
  )

  it.effect('an open still loading in one library does not pull the window back from another', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const claude = makeFakeClaude()
      const { manager } = yield* setup(
        { before: (method) => (method === 'thread/resume' ? Deferred.await(gate) : Effect.void) },
        { claude: ClaudeAdapter.make(() => Promise.resolve(claude.sdk)) },
      )
      const opening = yield* Effect.forkScoped(manager.dispatch({ op: 'openThread', threadId: 'thr_1' }))
      yield* settle
      yield* manager.dispatch({ op: 'setProvider', provider: 'claude' })
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(opening)
      yield* settle
      expect(yield* manager.snapshot).toMatchObject({ provider: 'claude', route: { kind: 'home' } })
      yield* manager.dispatch({ op: 'setProvider', provider: 'codex' })
      expect((yield* manager.snapshot).route).toEqual({ kind: 'doc', threadId: 'thr_1' })
    }),
  )

  it.effect('restarts a connection whose events hit a defect, showing a plain sentence and logging the cause', () => {
    const { logged, layer } = captureErrorLogs()
    return Effect.gen(function* () {
      const peer = makeFakeCodex()
      const codex = CodexAdapter.make(peer.connect)
      let broken = true
      const flaky: LegacyProviderAdapter = {
        ...codex,
        openSession: Effect.map(codex.openSession, (session) =>
          broken ? ((broken = false), { ...session, events: Stream.die(new Error('bad frame')) }) : session,
        ),
      }
      const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
        Effect.provide(layerAdapters({ codex: fromLegacy(flaky) })),
      )
      yield* manager.start('codex')
      const lost = yield* until(manager, (snapshot) => snapshot.error !== null)
      expect(lost).toMatchObject({
        status: 'connecting',
        error: 'Something went wrong. Docs saved a report and is reconnecting.',
      })
      expect(logged).toEqual([
        {
          cause: expect.stringContaining('bad frame'),
          annotations: { provider: 'codex', reportId: expect.stringMatching(/^[0-9a-f]{8}$/) },
        },
      ])
      yield* TestClock.adjust('1 second')
      yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
      expect(peer.connections()).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect('restarts Codex when a notification handler dies, instead of freezing the page', () => {
    const { logged, layer } = captureErrorLogs()
    return Effect.gen(function* () {
      const peer = makeFakeCodex()
      const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
        Effect.provide(layerAdapters({ codex: brokenOnce(peer, 'turn/started', 'turn', 'mapper bug') })),
      )
      yield* manager.start('codex')
      yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', provider: 'codex', threadId: 'thr_1', text: 'Hi' })
      const lost = yield* until(manager, (snapshot) => snapshot.error !== null)
      expect(lost).toMatchObject({
        status: 'connecting',
        error: 'Something went wrong. Docs saved a report and is reconnecting.',
      })
      expect(logged).toEqual([
        {
          cause: expect.stringContaining('mapper bug'),
          annotations: { provider: 'codex', reportId: expect.stringMatching(/^[0-9a-f]{8}$/) },
        },
      ])
      yield* TestClock.adjust('1 second')
      yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
      expect(peer.connections()).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect('restarts Codex when an approval handler dies, instead of leaving the turn waiting', () => {
    const { logged, layer } = captureErrorLogs()
    return Effect.gen(function* () {
      const peer = makeFakeCodex()
      const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
        Effect.provide(
          layerAdapters({
            codex: brokenOnce(peer, 'item/commandExecution/requestApproval', 'command', 'approval bug'),
          }),
        ),
      )
      yield* manager.start('codex')
      yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* peer
        .request('item/commandExecution/requestApproval', {
          threadId: 'thr_1',
          turnId: 'turn_1',
          itemId: 'cmd_1',
          command: 'ls',
          startedAtMs: 1,
        })
        .pipe(Effect.forkScoped)
      const lost = yield* until(manager, (snapshot) => snapshot.error !== null)
      expect(lost).toMatchObject({
        status: 'connecting',
        error: 'Something went wrong. Docs saved a report and is reconnecting.',
      })
      expect(logged).toEqual([
        {
          cause: expect.stringContaining('approval bug'),
          annotations: { provider: 'codex', reportId: expect.stringMatching(/^[0-9a-f]{8}$/) },
        },
      ])
      yield* TestClock.adjust('1 second')
      yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
      expect(peer.connections()).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    'a library that fails to load says so and logs why, the others keep working, and it loads on the next try',
    () => {
      const { logged, layer } = captureErrorLogs()
      return Effect.gen(function* () {
        const peer = makeFakeCodex()
        let claudeLoads = 0
        const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
          Effect.provide(
            layerLoaders({
              codex: () => Promise.resolve(fromLegacy(CodexAdapter.make(peer.connect))),
              opencode: () => Promise.reject(new Error('unused')),
              claude: () =>
                claudeLoads++ === 0
                  ? Promise.reject(new Error('Cannot find module ./ClaudeAdapter'))
                  : Promise.resolve(fromLegacy(ClaudeAdapter.make(() => Promise.resolve(makeFakeClaude().sdk)))),
            }),
          ),
        )
        yield* manager.start('codex')
        yield* until(manager, (snapshot) => snapshot.status === 'ready')
        const shown = yield* Effect.forkScoped(
          manager.snapshots.pipe(
            Stream.takeUntil((snapshot) => snapshot.status === 'error'),
            Stream.runCollect,
          ),
        )
        yield* settle
        yield* manager.dispatch({ op: 'setProvider', provider: 'claude' })
        const seen = yield* Fiber.join(shown)
        const failed = seen[seen.length - 1]!
        expect(failed.error).toBe('Docs could not load Claude. Docs saved a report.')
        expect(logged).toEqual([
          {
            cause: expect.stringContaining('Cannot find module ./ClaudeAdapter'),
            annotations: { provider: 'claude', reportId: expect.any(String) },
          },
        ])
        // Not retried, so shown once, as an error: never first as a reconnect.
        expect(seen.filter((snapshot) => snapshot.error === failed.error && snapshot.status !== 'error')).toEqual([])
        yield* manager.dispatch({ op: 'setProvider', provider: 'codex' })
        expect(yield* until(manager, (snapshot) => snapshot.status === 'ready')).toMatchObject({ provider: 'codex' })
        yield* manager.dispatch({ op: 'setProvider', provider: 'claude' })
        expect(
          yield* until(manager, (snapshot) => snapshot.provider === 'claude' && snapshot.status === 'ready'),
        ).toMatchObject({ error: null })
        expect(claudeLoads).toBe(2)
      }).pipe(Effect.provide(layer))
    },
  )
})

/**
 * Turn control (`session/TurnController`). Races ARCH-1 already closed have their tests
 * there: a late terminal (`state.test.ts`), a doubled terminal (`turnTracker.test.ts`)
 * and Stop before the provider knew the turn (`legacyEvents.test.ts`).
 */
describe('ProviderSessionManager: turns', () => {
  /** Waits until the document on screen shows its turn as running. */
  const running = (manager: Service) =>
    until(
      manager,
      (snapshot) =>
        snapshot.streaming && snapshot.blocks.some((block) => block.kind === 'user' && !block.id.startsWith('local-')),
    )
  const interrupts = (peer: ReturnType<typeof makeFakeCodex>) =>
    peer.calls.filter((call) => call.method === 'turn/interrupt').map((call) => call.params)

  it.effect('two sends in one tick: the second is refused and one question shows', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup({ reply: null })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      // Both sends wait for the reconnect, so both check the document before either writes.
      yield* peer.exit(1, 'boom')
      yield* until(manager, (snapshot) => snapshot.status === 'connecting')
      const seen: Snapshot[] = []
      yield* Effect.forkScoped(
        Stream.runForEach(manager.snapshots, (snapshot) => Effect.sync(() => seen.push(snapshot))),
      )
      const sends = yield* Effect.forkScoped(
        Effect.all(
          [
            Effect.exit(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'First' })),
            Effect.exit(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Second' })),
          ],
          { concurrency: 'unbounded' },
        ),
      )
      yield* settle
      yield* TestClock.adjust('1 second')
      const exits = yield* Fiber.join(sends)
      yield* settle
      expect(exits.map(Exit.isSuccess)).toEqual([true, false])
      const shown = yield* manager.snapshot
      expect(shown.streaming).toBe(true)
      expect(shown.blocks.filter((block) => block.kind === 'user').map((block) => block.text)).toEqual(['First'])
      expect(countCalls(peer, 'turn/start')).toBe(1)
      // Not even for a moment: no snapshot showed the refused question.
      expect(
        seen.some((snapshot) => snapshot.blocks.some((block) => block.kind === 'user' && block.text === 'Second')),
      ).toBe(false)
    }),
  )

  it.effect('Stop stops the document it names, even after the window moved to another one', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup({ reply: null })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'First' })
      yield* running(manager)
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_2' })
      yield* manager.dispatch({ op: 'send', ...doc('thr_2'), text: 'Second' })
      yield* running(manager)

      // Pressed while thr_1 was on screen; the navigation to thr_2 landed first.
      yield* manager.dispatch({ op: 'interrupt', ...doc('thr_1') })
      yield* settle
      expect(interrupts(peer)).toEqual([expect.objectContaining({ threadId: 'thr_1' })])
      expect(yield* manager.snapshot).toMatchObject({ route: { threadId: 'thr_2' }, streaming: true, stopping: false })
    }),
  )

  it.effect('a command for a document that was released is refused, not run on the one on screen', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup({ reply: null })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_2' })
      const error = yield* Effect.flip(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Hello' }))
      expect(error.message).toBe('That document is no longer open.')
      expect(countCalls(peer, 'turn/start')).toBe(0)
    }),
  )

  it.effect('a stop the provider never confirms settles after 10 s and reloads the document next time', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup({
        reply: null,
        // Codex accepts the stop but never ends the turn.
        handlers: { 'turn/interrupt': () => Effect.succeed({}) },
      })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Write a long essay' })
      yield* running(manager)
      yield* manager.dispatch({ op: 'interrupt', ...doc('thr_1') })
      expect(yield* manager.snapshot).toMatchObject({ streaming: true, stopping: true })

      yield* TestClock.adjust('9 seconds')
      yield* settle
      expect((yield* manager.snapshot).stopping).toBe(true)
      yield* TestClock.adjust('1 second')
      yield* settle
      expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false })

      // The provider may still be working on it, so reopening reads it again.
      yield* manager.dispatch({ op: 'goHome' })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      expect(countCalls(peer, 'thread/resume')).toBe(2)
    }),
  )

  it.effect('a Stop that crosses the end of the answer is not an error', () =>
    Effect.gen(function* () {
      let peer: ReturnType<typeof makeFakeCodex> | null = null
      const setUp = yield* setup({
        reply: null,
        handlers: {
          // The answer ends on its own just before the stop lands, so Codex has nothing left to stop.
          'turn/interrupt': (params) =>
            Effect.suspend(() =>
              peer
                ? peer.notify('turn/completed', {
                    threadId: params.threadId,
                    turn: { id: params.turnId, items: [], status: 'completed' },
                  })
                : Effect.void,
            ).pipe(Effect.andThen(Effect.fail(rpcFailure('no active turn to interrupt')))),
        },
      })
      peer = setUp.peer
      const { manager } = setUp
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Write a long essay' })
      yield* running(manager)
      yield* manager.dispatch({ op: 'interrupt', ...doc('thr_1') })
      expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false, error: null })
    }),
  )

  it.effect("a stop the provider refuses says so in Docs' words and leaves the answer running", () => {
    const { logged, layer } = captureWarnings()
    return Effect.gen(function* () {
      const { manager } = yield* setup({
        reply: null,
        handlers: { 'turn/interrupt': () => Effect.fail(rpcFailure('codex: no such turn')) },
      })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Write a long essay' })
      yield* running(manager)
      const stop = yield* Effect.forkChild(Effect.exit(manager.dispatch({ op: 'interrupt', ...doc('thr_1') })))
      // Refused at once; the command fails once the grace for the turn's own end runs out.
      yield* settle
      yield* TestClock.adjust('1 second')
      const exit = yield* Fiber.join(stop)
      if (Exit.isSuccess(exit)) return expect.fail('the refused stop succeeded')
      // What the IPC boundary puts on the banner.
      const banner = yield* describeFailure(exit.cause)
      expect(banner).toBe(STOP_FAILED)
      expect(banner).not.toContain('no such turn')
      expect(banner.toLowerCase()).not.toContain('codex')
      yield* TestClock.adjust('10 seconds')
      yield* settle
      const shown = yield* manager.snapshot
      expect(shown).toMatchObject({ streaming: true, stopping: false })
      expect(JSON.stringify(shown)).not.toContain('no such turn')
      // The log says why by the error's fields, never its text.
      const refused = logged.filter((entry) => JSON.stringify(entry.message).includes('Stop refused'))
      expect(refused).toHaveLength(1)
      expect(refused[0]?.annotations).toMatchObject({
        error: 'ProviderRequestError',
        provider: 'codex',
        operation: 'turn/interrupt',
      })
      expect(JSON.stringify(refused[0]?.annotations)).not.toContain('no such turn')
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    'a Stop pressed during a slow start is held, sent once the start lands, and never shows running again',
    () =>
      Effect.gen(function* () {
        const { peer, manager } = yield* setup({
          reply: null,
          handlers: {
            'turn/start': () =>
              Effect.sleep('15 seconds').pipe(
                Effect.as({ turn: { id: 'turn_slow', items: [], status: 'inProgress' as const } }),
              ),
          },
        })
        yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
        yield* Effect.forkScoped(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Write a long essay' }))
        yield* until(manager, (snapshot) => snapshot.streaming)
        const stop = yield* Effect.forkChild(Effect.exit(manager.dispatch({ op: 'interrupt', ...doc('thr_1') })))
        yield* until(manager, (snapshot) => snapshot.stopping)
        yield* settle
        // The deadline ends the turn on the page; the stop is still waiting for the start.
        yield* TestClock.adjust('10 seconds')
        yield* settle
        expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false })
        const reopened = yield* Effect.forkScoped(until(manager, (snapshot) => snapshot.streaming))
        yield* TestClock.adjust('5 seconds')
        yield* settle
        expect(interrupts(peer)).toHaveLength(1)
        expect(Exit.isSuccess(yield* Fiber.join(stop))).toBe(true)
        expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false })
        // The late start did not flash the settled turn back to running.
        expect(reopened.pollUnsafe()).toBeUndefined()
      }),
  )

  it.effect(
    'a send after the deadline waits for the held Stop, so the first turn is stopped and the new one runs',
    () =>
      Effect.gen(function* () {
        let starts = 0
        const { peer, manager } = yield* setup({
          reply: null,
          handlers: {
            // The first start is slow; the next answers at once.
            'turn/start': () =>
              (starts += 1) === 1
                ? Effect.sleep('15 seconds').pipe(
                    Effect.as({ turn: { id: 'turn_slow', items: [], status: 'inProgress' as const } }),
                  )
                : Effect.succeed({ turn: { id: 'turn_next', items: [], status: 'inProgress' as const } }),
          },
        })
        yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
        yield* Effect.forkScoped(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Write a long essay' }))
        yield* until(manager, (snapshot) => snapshot.streaming)
        yield* Effect.forkScoped(manager.dispatch({ op: 'interrupt', ...doc('thr_1') }))
        yield* until(manager, (snapshot) => snapshot.stopping)
        yield* settle
        yield* TestClock.adjust('10 seconds')
        yield* settle
        expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false })
        // The page says stopped, so the person asks again.
        yield* TestClock.adjust('1 second')
        const again = yield* Effect.forkChild(
          Effect.exit(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'A shorter one' })),
        )
        yield* settle
        yield* TestClock.adjust('4 seconds')
        yield* settle
        expect(Exit.isSuccess(yield* Fiber.join(again))).toBe(true)
        expect(interrupts(peer)).toEqual([expect.objectContaining({ threadId: 'thr_1', turnId: 'turn_slow' })])
        expect(countCalls(peer, 'turn/start')).toBe(2)
        expect(yield* manager.snapshot).toMatchObject({ streaming: true, stopping: false })
      }),
  )

  it.effect('a Stop on a send still waiting for the held Stop keeps it from being sent, and the next send works', () =>
    Effect.gen(function* () {
      let starts = 0
      const { peer, manager } = yield* setup({
        reply: null,
        handlers: {
          'turn/start': () =>
            (starts += 1) === 1
              ? Effect.sleep('15 seconds').pipe(
                  Effect.as({ turn: { id: 'turn_slow', items: [], status: 'inProgress' as const } }),
                )
              : Effect.succeed({ turn: { id: 'turn_next', items: [], status: 'inProgress' as const } }),
        },
      })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* Effect.forkScoped(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Write a long essay' }))
      yield* until(manager, (snapshot) => snapshot.streaming)
      yield* Effect.forkScoped(manager.dispatch({ op: 'interrupt', ...doc('thr_1') }))
      yield* until(manager, (snapshot) => snapshot.stopping)
      yield* settle
      yield* TestClock.adjust('10 seconds')
      yield* settle
      // The person asks again, then thinks better of it while that waits for the first Stop.
      yield* TestClock.adjust('1 second')
      const again = yield* Effect.forkChild(
        Effect.exit(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'A shorter one' })),
      )
      yield* until(manager, (snapshot) => snapshot.streaming)
      yield* TestClock.adjust('1 second')
      const stop = yield* Effect.forkChild(Effect.exit(manager.dispatch({ op: 'interrupt', ...doc('thr_1') })))
      yield* settle
      // Settled at the click, not 10 s later by the deadline.
      expect(Exit.isSuccess(yield* Fiber.join(stop))).toBe(true)
      expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false })
      // The first start lands: its stop goes out, and the second message is never sent.
      yield* TestClock.adjust('3 seconds')
      yield* settle
      expect(Exit.isSuccess(yield* Fiber.join(again))).toBe(true)
      expect(countCalls(peer, 'turn/start')).toBe(1)
      expect(interrupts(peer)).toEqual([expect.objectContaining({ threadId: 'thr_1', turnId: 'turn_slow' })])
      expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false })
      yield* manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'One line, then' })
      yield* settle
      expect(countCalls(peer, 'turn/start')).toBe(2)
      expect(yield* manager.snapshot).toMatchObject({ streaming: true, stopping: false })
    }),
  )

  it.effect("a send waits for the previous send's answer, so Stop names the newer turn", () =>
    Effect.gen(function* () {
      // The first start is slow, and its notification comes a second before its answer.
      let starts = 0
      const slow = { id: 'turn_slow', items: [], status: 'inProgress' as const }
      let notifySlow: Effect.Effect<void> = Effect.void
      const { peer, manager } = yield* setup({
        reply: null,
        handlers: {
          'turn/start': () =>
            (starts += 1) === 1
              ? Effect.gen(function* () {
                  yield* Effect.sleep('15 seconds')
                  yield* notifySlow
                  yield* Effect.sleep('1 second')
                  return { turn: slow }
                })
              : Effect.succeed({ turn: { id: 'turn_next', items: [], status: 'inProgress' as const } }),
        },
      })
      notifySlow = peer.notify('turn/started', { threadId: 'thr_1', turn: slow })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* Effect.forkScoped(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Write a long essay' }))
      yield* until(manager, (snapshot) => snapshot.streaming)
      yield* Effect.forkScoped(manager.dispatch({ op: 'interrupt', ...doc('thr_1') }))
      yield* until(manager, (snapshot) => snapshot.stopping)
      yield* settle
      yield* TestClock.adjust('10 seconds')
      yield* settle
      yield* TestClock.adjust('1 second')
      const again = yield* Effect.forkChild(
        Effect.exit(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'A shorter one' })),
      )
      yield* settle
      // The notification lets the held stop out; the slow answer lands a second later.
      yield* TestClock.adjust('4 seconds')
      yield* settle
      yield* TestClock.adjust('1 second')
      yield* settle
      expect(Exit.isSuccess(yield* Fiber.join(again))).toBe(true)
      yield* manager.dispatch({ op: 'interrupt', ...doc('thr_1') })
      yield* settle
      expect(interrupts(peer)).toEqual([
        expect.objectContaining({ turnId: 'turn_slow' }),
        expect.objectContaining({ turnId: 'turn_next' }),
      ])
    }),
  )

  it.effect('a question whose start never comes stays on the page after the deadline settled it', () =>
    Effect.gen(function* () {
      const { manager } = yield* setup({ reply: null, handlers: { 'turn/start': () => Effect.never } })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      const sent = yield* Effect.forkChild(
        Effect.exit(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Write a long essay' })),
      )
      yield* until(manager, (snapshot) => snapshot.streaming)
      const stop = yield* Effect.forkChild(Effect.exit(manager.dispatch({ op: 'interrupt', ...doc('thr_1') })))
      yield* until(manager, (snapshot) => snapshot.stopping)
      yield* settle
      yield* TestClock.adjust('10 seconds')
      yield* settle
      const asked = (snapshot: Snapshot) =>
        snapshot.blocks.some((block) => block.kind === 'user' && block.text === 'Write a long essay')
      expect(asked(yield* manager.snapshot)).toBe(true)
      // The start's own deadline fails the send; the question it already showed as stopped stays.
      yield* TestClock.adjust('60 seconds')
      yield* settle
      expect(Exit.isFailure(yield* Fiber.join(sent))).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.join(stop))).toBe(true)
      expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false })
      expect(asked(yield* manager.snapshot)).toBe(true)
    }),
  )

  it.effect('a crash while Stop waits for the start ends the Stop instead of leaving it waiting', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup({ reply: null, handlers: { 'turn/start': () => Effect.never } })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* Effect.forkScoped(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Write a long essay' }))
      yield* until(manager, (snapshot) => snapshot.streaming)
      const stop = yield* Effect.forkChild(Effect.exit(manager.dispatch({ op: 'interrupt', ...doc('thr_1') })))
      yield* until(manager, (snapshot) => snapshot.stopping)
      yield* settle
      yield* peer.exit(1, 'boom')
      yield* settle
      // No clock moved: the crash failed the pending start, and the send, abandoning its turn,
      // ended the wait.
      const done = stop.pollUnsafe()
      expect(done && Exit.isSuccess(done)).toBe(true)
      expect(interrupts(peer)).toEqual([])
    }),
  )

  it.effect('a Stop between the page opening the turn and the session taking the send keeps it unsent', () =>
    Effect.gen(function* () {
      const peer = makeFakeCodex({ reply: null })
      const codex = fromLegacy(CodexAdapter.make(peer.connect))
      const gate = yield* Deferred.make<void>()
      let held = true
      const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
        Effect.provide(
          layerAdapters({
            codex: {
              ...codex,
              // The first send reaches the session only once the gate opens: the fiber yielded
              // after the page opened the turn.
              openSession: Effect.map(codex.openSession, (session) => ({
                ...session,
                send: (...args: Parameters<typeof session.send>) =>
                  held
                    ? Deferred.await(gate).pipe(
                        Effect.tap(() => Effect.sync(() => (held = false))),
                        Effect.andThen(session.send(...args)),
                      )
                    : session.send(...args),
              })),
            },
          }),
        ),
      )
      yield* manager.start('codex')
      yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      const sent = yield* Effect.forkChild(
        Effect.exit(manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Write a long essay' })),
      )
      yield* until(manager, (snapshot) => snapshot.streaming)
      yield* manager.dispatch({ op: 'interrupt', ...doc('thr_1') })
      yield* Deferred.succeed(gate, undefined)
      yield* settle
      expect(Exit.isSuccess(yield* Fiber.join(sent))).toBe(true)
      expect(countCalls(peer, 'turn/start')).toBe(0)
      expect(countCalls(peer, 'turn/interrupt')).toBe(0)
      // Settled at once, not by the deadline.
      expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false })
      yield* manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'A shorter one' })
      yield* settle
      expect(countCalls(peer, 'turn/start')).toBe(1)
      expect(yield* manager.snapshot).toMatchObject({ streaming: true, stopping: false })
    }),
  )

  it.effect('a stop that times out is left to the deadline, not put back to running', () =>
    Effect.gen(function* () {
      const peer = makeFakeCodex({ reply: null })
      const codex = fromLegacy(CodexAdapter.make(peer.connect))
      const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
        Effect.provide(
          layerAdapters({
            codex: {
              ...codex,
              // A stop request that the provider never answers, timing out before the deadline
              // (an adapter whose own request deadline is shorter than `STOP_SETTLE`).
              openSession: Effect.map(codex.openSession, (session) => ({
                ...session,
                interrupt: () =>
                  Effect.sleep('9 seconds').pipe(
                    Effect.andThen(
                      Effect.fail(new ProviderTimeoutError({ provider: 'codex', operation: 'interrupt', seconds: 9 })),
                    ),
                  ),
              })),
            },
          }),
        ),
      )
      yield* manager.start('codex')
      yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', ...doc('thr_1'), text: 'Write a long essay' })
      yield* running(manager)
      const stop = yield* Effect.forkChild(Effect.exit(manager.dispatch({ op: 'interrupt', ...doc('thr_1') })))
      yield* settle
      yield* TestClock.adjust('9 seconds')
      yield* settle
      expect(Exit.isSuccess(yield* Fiber.join(stop))).toBe(true)
      expect(yield* manager.snapshot).toMatchObject({ streaming: true, stopping: true })
      yield* TestClock.adjust('1 second')
      yield* settle
      expect(yield* manager.snapshot).toMatchObject({ streaming: false, stopping: false, error: null })
    }),
  )
})
