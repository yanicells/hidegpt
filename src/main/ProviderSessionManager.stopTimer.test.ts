import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Logger from 'effect/Logger'
import * as Option from 'effect/Option'
import * as References from 'effect/References'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { vi } from 'vitest'

import * as CodexAdapter from '../codex/CodexAdapter'
import { makeFakeCodex } from '../codex/FakeCodex'
import type { Snapshot } from '../shared/model'
import { layerAdapters } from './ProviderRegistry'
import * as Manager from './ProviderSessionManager'

// The stop timer's update is the only caller of `settle`; make it a Docs bug.
vi.mock('./session/state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session/state')>()),
  settle: () => {
    throw new Error('settle bug')
  },
}))

describe('ProviderSessionManager stop timer', () => {
  it.effect('logs a defect in the timer that frees a stopped document, which nobody waits on', () => {
    const logged: Array<{ readonly cause: string; readonly annotations: Record<string, unknown> }> = []
    const capture = Logger.make(({ cause, fiber, logLevel }) => {
      if (logLevel === 'Error') logged.push({ cause: Cause.pretty(cause), annotations: fiber.getRef(References.CurrentLogAnnotations) })
    })
    return Effect.gen(function* () {
      // Codex accepts the stop but never ends the turn, so only the timer can settle it.
      const peer = makeFakeCodex({ reply: null, handlers: { 'turn/interrupt': () => Effect.succeed({}) } })
      const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
        Effect.provide(layerAdapters({ codex: CodexAdapter.make(peer.connect) })),
      )
      const until = (predicate: (snapshot: Snapshot) => boolean) =>
        manager.snapshots.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))
      yield* manager.start('codex')
      yield* until((snapshot) => snapshot.status === 'ready')
      yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
      yield* manager.dispatch({ op: 'send', text: 'Write a long essay' })
      // Codex's echo of the sent text: the turn is running on its side.
      yield* until((snapshot) => snapshot.blocks.some((block) => block.kind === 'user' && !block.id.startsWith('local-')))
      yield* manager.dispatch({ op: 'interrupt' })
      yield* until((snapshot) => snapshot.stopping)
      expect(logged).toEqual([])

      yield* TestClock.adjust('10 seconds')
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 30 }))
      expect(logged).toEqual([{ cause: expect.stringContaining('settle bug'), annotations: { reportId: expect.stringMatching(/^[0-9a-f]{8}$/) } }])
    }).pipe(Effect.provide(Logger.layer([capture])))
  })
})
