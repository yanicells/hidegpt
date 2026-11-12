import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import * as CodexAdapter from '../../codex/CodexAdapter'
import { makeFakeCodex } from '../../codex/FakeCodex'
import { fromLegacy } from '../../provider/legacyEvents'
import type { Block, Snapshot } from '../../shared/model'
import { layer } from '../logging/ProviderEventLog'
import { layerAdapters } from '../ProviderRegistry'
import * as Manager from '../ProviderSessionManager'
import { presentFailure, presentItems } from './present'
import { replayedRuntime, replayEventLog } from './replay'

type Service = Manager.ProviderSessionManager['Service']

const until = (manager: Service, predicate: (snapshot: Snapshot) => boolean) =>
  manager.snapshots.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))

const confirmedSend = (snapshot: Snapshot) =>
  snapshot.streaming && snapshot.blocks.some((block) => block.kind === 'user' && !block.id.startsWith('local-'))

/**
 * What the replay can be held to: the blocks' kinds, in order. Not how a
 * question was answered: main marks that itself when the reply goes out, with
 * no event, so in the log the request stays open until its turn ends.
 */
const kinds = (blocks: ReadonlyArray<Block>) => blocks.map((block) => block.kind)

/** Consecutive duplicates dropped: [false, true, true, false] is [false, true, false]. */
const changes = <A>(values: ReadonlyArray<A>) =>
  values.filter((value, index) => index === 0 || values[index - 1] !== value)

describe('replaying the activity log', () => {
  it.effect('a fake session replays to the turns and items the page showed', () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), 'docs-replay-'))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
      const shown: Snapshot[] = []

      yield* Effect.gen(function* () {
        const peer = makeFakeCodex({ reply: null })
        const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
          Effect.provide(layerAdapters({ codex: fromLegacy(CodexAdapter.make(peer.connect)) })),
        )
        yield* manager.start('codex')
        yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
        yield* manager.snapshots.pipe(
          Stream.runForEach((snapshot) => Effect.sync(() => shown.push(snapshot))),
          Effect.forkScoped({ startImmediately: true }),
        )

        // Turn 1: an answer, a command with output, and a question the person accepts.
        yield* manager.dispatch({ op: 'send', text: 'Prompt Secret-1' })
        yield* until(manager, confirmedSend)
        const ids = { threadId: 'thr_1', turnId: 'turn_1' }
        yield* peer.notify('item/agentMessage/delta', { ...ids, itemId: 'agent_1', delta: 'Answer ' })
        yield* peer.notify('item/agentMessage/delta', { ...ids, itemId: 'agent_1', delta: 'Secret-2' })
        yield* peer.notify('item/commandExecution/outputDelta', { ...ids, itemId: 'cmd_1', delta: 'Secret-3' })
        const answer = yield* peer
          .request('item/commandExecution/requestApproval', {
            ...ids,
            itemId: 'cmd_2',
            command: 'Secret-4',
            startedAtMs: 1,
          })
          .pipe(Effect.forkScoped)
        const asked = yield* until(manager, (snapshot) => snapshot.blocks.some((block) => block.kind === 'approval'))
        const approval = asked.blocks.find((block) => block.kind === 'approval')!
        yield* manager.dispatch({ op: 'resolveApproval', blockId: approval.id, accept: true })
        yield* Fiber.join(answer)
        yield* peer.notify('turn/completed', {
          threadId: 'thr_1',
          turn: { id: 'turn_1', items: [], status: 'completed' },
        })
        yield* until(manager, (snapshot) => !snapshot.streaming)

        // Turn 2 fails with the provider's own words, which only the log's lengths keep.
        yield* manager.dispatch({ op: 'send', text: 'Second Secret-5' })
        yield* until(manager, confirmedSend)
        const error = {
          message: 'rate limited Secret-6',
          codexErrorInfo: 'rateLimitExceeded' as const,
          additionalDetails: null,
          misalignment: null,
        }
        yield* peer.notify('error', { error, willRetry: false, threadId: 'thr_1', turnId: 'turn_2' })
        yield* until(manager, (snapshot) => !snapshot.streaming)

        // Turn 3 is stopped. Then the document is renamed.
        yield* manager.dispatch({ op: 'send', text: 'Third Secret-7' })
        yield* until(manager, confirmedSend)
        yield* manager.dispatch({ op: 'interrupt' })
        yield* until(manager, (snapshot) => !snapshot.streaming)
        yield* peer.notify('thread/name/updated', { threadId: 'thr_1', threadName: 'Secret-8' })
        yield* until(manager, (snapshot) => snapshot.title === 'Secret-8')
      }).pipe(Effect.scoped, Effect.provide(layer(dir)))

      const log = readFileSync(join(dir, 'personal.ndjson'), 'utf8')
      expect(log).not.toMatch(/Secret/)

      const replay = replayEventLog(log.split('\n'))
      expect(replay.skipped).toBe(0)
      const [thread] = replay.threads
      expect(thread).toMatchObject({ provider: 'codex', threadId: 'thr_1' })

      // The same working/idle sequence the page showed, one stretch per turn, and nothing left open.
      const working = changes(shown.map((snapshot) => snapshot.streaming))
      expect(working).toEqual([false, true, false, true, false, true, false])
      expect(thread!.turns.map((turn) => [turn.status, turn.failure])).toEqual([
        ['completed', null],
        ['failed', 'usage_limit'],
        ['interrupted', null],
      ])
      const runtime = replayedRuntime(replay, 'codex', 'thr_1')!
      expect(runtime.turn).toBeNull()

      // The banner the failed turn raised comes back word for word: the page never shows provider text.
      const banner = shown.find((snapshot) => snapshot.error)?.error
      expect(presentFailure({ class: 'usage_limit', detail: '', retryable: null, resetAt: null })).toBe(banner)

      // The same blocks in the same order.
      const last = shown.at(-1)!
      expect(kinds(presentItems(runtime.items))).toEqual(kinds(last.blocks))
      expect(kinds(last.blocks)).toEqual(['user', 'agent', 'callout', 'approval', 'user', 'user'])
      expect(runtime.title).toHaveLength('Secret-8'.length)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
