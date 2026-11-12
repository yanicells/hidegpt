import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import * as CodexAdapter from '../codex/CodexAdapter'
import { makeFakeCodex } from '../codex/FakeCodex'
import { fromLegacy } from '../provider/legacyEvents'
import type { ProviderAdapter, ProviderSession } from '../provider/ProviderAdapter'
import type { Snapshot } from '../shared/model'
import { layerAdapters } from './ProviderRegistry'
import * as Manager from './ProviderSessionManager'

/**
 * A command whose provider call dies (a Docs bug, not a provider error) must undo its
 * optimistic state the same way a typed failure does. `Effect.tapError` only sees typed
 * failures, so a rollback written with it leaves the state behind.
 */

/** The adapter with some session methods replaced. */
const patched = (adapter: ProviderAdapter, patch: Partial<ProviderSession>): ProviderAdapter => ({
  ...adapter,
  openSession: Effect.map(adapter.openSession, (session) => ({ ...session, ...patch })),
})

const setup = (patch: Partial<ProviderSession>) =>
  Effect.gen(function* () {
    const peer = makeFakeCodex()
    const manager = yield* Manager.make({
      defaultCwd: () => '/tmp/docs',
      openExternal: () => Effect.void,
    }).pipe(Effect.provide(layerAdapters({ codex: patched(fromLegacy(CodexAdapter.make(peer.connect)), patch) })))
    yield* manager.start('codex')
    yield* until(manager, (snapshot) => snapshot.status === 'ready' && snapshot.models.length > 0)
    return { peer, manager }
  })

const until = (manager: Manager.ProviderSessionManager['Service'], predicate: (snapshot: Snapshot) => boolean) =>
  manager.snapshots.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))

const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 30 }))
const bug = (where: string) => Effect.die(new Error(`a Docs bug in ${where}`))

describe('ProviderSessionManager: a defect undoes the optimistic state', () => {
  it.effect('send: the echo goes and the document stops "working"', () =>
    Effect.gen(function* () {
      const { manager } = yield* setup({ send: () => bug('send') })
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })

      const exit = yield* Effect.exit(
        manager.dispatch({ op: 'send', provider: 'codex', threadId: 'thr_1', text: 'Why are leaves green?' }),
      )
      expect(Exit.isFailure(exit)).toBe(true)

      const shown = yield* manager.snapshot
      expect(shown.streaming).toBe(false)
      expect(shown.blocks.some((block) => block.kind === 'user' && block.text === 'Why are leaves green?')).toBe(false)
    }),
  )

  it.effect('resolveApproval: the question can be answered again', () =>
    Effect.gen(function* () {
      const { peer, manager } = yield* setup({ respond: () => bug('respond') })
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
      yield* settle
      const approval = (yield* manager.snapshot).blocks.find((block) => block.kind === 'approval')
      expect(approval).toMatchObject({ resolved: null })

      const exit = yield* Effect.exit(
        manager.dispatch({
          op: 'resolveApproval',
          provider: 'codex',
          threadId: 'thr_1',
          blockId: approval?.id ?? '',
          accept: true,
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      // `pending: true` here means every later click returns early: the turn waits forever.
      expect((yield* manager.snapshot).blocks.find((block) => block.kind === 'approval')).toMatchObject({
        pending: false,
        resolved: null,
      })
    }),
  )

  it.effect('openThread: Home stops showing the document as opening', () =>
    Effect.gen(function* () {
      const { manager } = yield* setup({ openThread: () => bug('openThread') })

      const exit = yield* Effect.exit(manager.dispatch({ op: 'openThread', threadId: 'thr_1' }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* manager.snapshot).openingThreadId).toBeNull()
    }),
  )
})
