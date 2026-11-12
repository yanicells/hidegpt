import { describe, expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import * as ClaudeAdapter from '../claude/ClaudeAdapter'
import { makeFakeClaude } from '../claude/FakeClaude'
import * as CodexAdapter from '../codex/CodexAdapter'
import { agentItem, makeFakeCodex, stubTurn, userItem, type FakeCodexOptions } from '../codex/FakeCodex'
import type { ProviderAdapter } from '../provider/ProviderAdapter'
import type { Snapshot } from '../shared/model'
import { layerAdapters, layerLoaders } from './ProviderRegistry'
import * as Manager from './ProviderSessionManager'

/**
 * The session manager over the real Codex adapter and the in-process Codex
 * peer: only the process boundary is fake, so these cover the same paths the
 * app runs (T3 Code's replay-fixture approach).
 */
const setup = (options: FakeCodexOptions = {}, others: { claude?: ProviderAdapter } = {}) =>
  Effect.gen(function* () {
    const peer = makeFakeCodex(options)
    const opened: string[] = []
    const manager = yield* Manager.make({
      defaultCwd: () => '/tmp/docs',
      openExternal: (url) => Effect.sync(() => opened.push(url)),
    }).pipe(Effect.provide(layerAdapters({ codex: CodexAdapter.make(peer.connect), ...others })))
    yield* manager.start('codex')
    yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
    return { peer, manager, opened }
  })

type Service = Manager.ProviderSessionManager['Service']

/** The first snapshot that matches. */
const until = (manager: Service, predicate: (snapshot: Snapshot) => boolean) =>
  manager.snapshots.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 30 }))
const countCalls = (peer: { calls: ReadonlyArray<{ method: string }> }, method: string) =>
  peer.calls.filter((call) => call.method === method).length

describe('ProviderSessionManager', () => {
  it.effect('keeps a turn streaming while the window is on Home, and reopens it instantly', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup({ reply: () => 'Chlorophyll absorbs light.', deltaDelayMs: 100 })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', text: 'Why are leaves green?' })
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

      yield* manager.dispatch({ op: 'resolveApproval', blockId: approval?.id ?? '', accept: true })
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
      yield* manager.dispatch({ op: 'send', text: 'Write a long essay' })
      yield* until(manager, (snapshot) =>
        snapshot.blocks.some((block) => block.kind === 'user' && !block.id.startsWith('local-')),
      )
      const stopping = yield* Effect.forkScoped(until(manager, (snapshot) => snapshot.stopping))
      yield* manager.dispatch({ op: 'interrupt' })
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
      yield* manager.dispatch({ op: 'send', text: 'First' })
      yield* until(
        manager,
        (snapshot) =>
          snapshot.streaming &&
          snapshot.blocks.some((block) => block.kind === 'user' && !block.id.startsWith('local-')),
      )
      yield* Effect.forkScoped(manager.dispatch({ op: 'interrupt' }))
      yield* until(manager, (snapshot) => snapshot.stopping)
      yield* peer.exit(1, 'boom')
      yield* until(manager, (snapshot) => snapshot.status === 'connecting')
      yield* TestClock.adjust('1 second')
      yield* until(manager, (snapshot) => snapshot.status === 'ready')
      yield* settle
      yield* manager.dispatch({ op: 'send', text: 'Second' })
      yield* until(manager, (snapshot) => snapshot.streaming && !snapshot.stopping)
      yield* TestClock.adjust('10 seconds')
      yield* settle
      expect((yield* manager.snapshot).streaming).toBe(true)
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
      yield* manager.dispatch({ op: 'loadOlderTurns' })
      const done = yield* Fiber.join(loaded)
      expect(done.blocks.map((block) => block.id)).toEqual(['u0', 'u1', 'a1'])
      expect(done.hasOlder).toBe(false)
    }),
  )

  it.effect('refuses an empty send so the composer keeps the draft', () =>
    Effect.gen(function* () {
      const { manager } = yield* setup()
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      const error = yield* Effect.flip(manager.dispatch({ op: 'send', text: '   ' }))
      expect(error.message).toBe('There is nothing to send.')
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

  it.effect('restarts a connection whose events hit a defect instead of leaving it frozen', () =>
    Effect.gen(function* () {
      const peer = makeFakeCodex()
      const codex = CodexAdapter.make(peer.connect)
      let broken = true
      const flaky: ProviderAdapter = {
        ...codex,
        openSession: Effect.map(codex.openSession, (session) =>
          broken ? ((broken = false), { ...session, events: Stream.die(new Error('bad frame')) }) : session,
        ),
      }
      const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
        Effect.provide(layerAdapters({ codex: flaky })),
      )
      yield* manager.start('codex')
      const lost = yield* until(manager, (snapshot) => snapshot.error !== null)
      expect(lost).toMatchObject({
        status: 'connecting',
        error: 'Codex stopped unexpectedly: bad frame. Docs is reconnecting.',
      })
      yield* TestClock.adjust('1 second')
      yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
      expect(peer.connections()).toBe(2)
    }),
  )

  it.effect('a library that fails to load shows why, the others keep working, and it loads on the next try', () =>
    Effect.gen(function* () {
      const peer = makeFakeCodex()
      let claudeLoads = 0
      const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
        Effect.provide(
          layerLoaders({
            codex: () => Promise.resolve(CodexAdapter.make(peer.connect)),
            opencode: () => Promise.reject(new Error('unused')),
            claude: () =>
              claudeLoads++ === 0
                ? Promise.reject(new Error('Cannot find module ./ClaudeAdapter'))
                : Promise.resolve(ClaudeAdapter.make(() => Promise.resolve(makeFakeClaude().sdk))),
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
      expect(failed.error).toBe('Docs could not load Claude: Cannot find module ./ClaudeAdapter')
      // Not retried, so shown once, as an error: never first as a reconnect.
      expect(seen.filter((snapshot) => snapshot.error === failed.error && snapshot.status !== 'error')).toEqual([])
      yield* manager.dispatch({ op: 'setProvider', provider: 'codex' })
      expect(yield* until(manager, (snapshot) => snapshot.status === 'ready')).toMatchObject({ provider: 'codex' })
      yield* manager.dispatch({ op: 'setProvider', provider: 'claude' })
      expect(
        yield* until(manager, (snapshot) => snapshot.provider === 'claude' && snapshot.status === 'ready'),
      ).toMatchObject({ error: null })
      expect(claudeLoads).toBe(2)
    }),
  )
})
