import { describe, expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import * as CodexAdapter from '../codex/CodexAdapter'
import { agentItem, makeFakeCodex, stubTurn, userItem, type FakeCodexOptions } from '../codex/FakeCodex'
import type { Snapshot } from '../shared/model'
import { layerAdapters } from './ProviderRegistry'
import * as Manager from './ProviderSessionManager'

/**
 * The session manager over the real Codex adapter and the in-process Codex
 * peer: only the process boundary is fake, so these cover the same paths the
 * app runs (T3 Code's replay-fixture approach).
 */
const setup = (options: FakeCodexOptions = {}) =>
  Effect.gen(function* () {
    const peer = makeFakeCodex(options)
    const opened: string[] = []
    const manager = yield* Manager.make({
      defaultCwd: () => '/tmp/docs',
      openExternal: (url) => Effect.sync(() => opened.push(url)),
    }).pipe(Effect.provide(layerAdapters({ codex: CodexAdapter.make(peer.connect) })))
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
      yield* until(manager, (snapshot) => snapshot.blocks.some((block) => block.kind === 'user' && !block.id.startsWith('local-')))
      const stopping = yield* Effect.forkScoped(until(manager, (snapshot) => snapshot.stopping))
      yield* manager.dispatch({ op: 'interrupt' })
      expect(yield* Fiber.join(stopping)).toMatchObject({ streaming: true, stopping: true })
      const ended = yield* until(manager, (snapshot) => !snapshot.streaming)
      expect(ended.stopping).toBe(false)
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
          method === 'thread/resume' && (params as { threadId: string }).threadId === 'thr_1' ? Deferred.await(gate) : Effect.void,
      })
      const slow = yield* Effect.forkScoped(manager.dispatch({ op: 'openThread', threadId: 'thr_1' }))
      yield* settle
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_2' })
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(slow)
      yield* settle
      const snapshot = yield* manager.snapshot
      expect(snapshot).toMatchObject({ route: { kind: 'doc', threadId: 'thr_2' }, title: 'Chem lab', openingThreadId: null })
    }),
  )

  it.effect('restarts Codex after a crash and reloads the open document', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup({ turns: [stubTurn('turn_0', [userItem('u0', 'Hi'), agentItem('a0', 'Hello.')])] })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* peer.exit(1, 'Error: config.toml is invalid')
      const lost = yield* until(manager, (snapshot) => snapshot.status === 'connecting')
      expect(lost.error).toBe('Codex stopped unexpectedly (exit 1): Error: config.toml is invalid. Docs is reconnecting.')
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
})
