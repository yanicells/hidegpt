import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import * as CodexAdapter from '../../codex/CodexAdapter'
import { makeFakeCodex } from '../../codex/FakeCodex'
import { fromLegacy } from '../../provider/legacyEvents'
import { layerAdapters } from '../ProviderRegistry'
import * as Manager from '../ProviderSessionManager'
import { describeEvent, layer } from './ProviderEventLog'

describe('ProviderEventLog', () => {
  it.effect('logs a turn by type and id, never what was written or answered', () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), 'hidegpt-provider-log-'))
      // Provided as a layer, as main does: the manager closes first, then the log writes what is queued.
      yield* Effect.gen(function* () {
        const peer = makeFakeCodex({ reply: () => 'Answer-7c1e chlorophyll absorbs red light.' })
        const manager = yield* Manager.make({ defaultCwd: () => '/tmp/docs', openExternal: () => Effect.void }).pipe(
          Effect.provide(layerAdapters({ codex: fromLegacy(CodexAdapter.make(peer.connect)) })),
        )
        yield* manager.start('codex')
        yield* manager.dispatch({ op: 'openThread', threadId: 'thr_1' })
        yield* manager.dispatch({ op: 'send', text: 'Prompt-4b9d why are leaves green?' })
        yield* manager.snapshots.pipe(
          Stream.filter((snapshot) => !snapshot.streaming && snapshot.blocks.some((block) => block.kind === 'agent')),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        )
      }).pipe(Effect.scoped, Effect.provide(layer(dir)))

      // Named for the library as the page shows it, never for the provider.
      expect(readdirSync(dir)).toEqual(['personal.ndjson'])
      const log = readFileSync(join(dir, 'personal.ndjson'), 'utf8')
      const types = log
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).type)
      expect(types).toEqual(expect.arrayContaining(['turn.started', 'item.upserted', 'turn.ended']))
      expect(types).not.toContain('item.delta')
      expect(log).not.toContain('Prompt-4b9d')
      expect(log).not.toContain('Answer-7c1e')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it('keeps sign-in links, titles, and error or notice text out of the log', () => {
    expect(describeEvent({ type: 'loginUrl', url: 'https://auth.example/?state=secret' })).toEqual({
      type: 'loginUrl',
      pending: true,
    })
    expect(describeEvent({ type: 'thread.renamed', threadId: 't1', title: 'My private essay' })).toEqual({
      type: 'thread.renamed',
      threadId: 't1',
    })
    // A provider can quote what was sent in its error ("invalid input: <prompt>").
    const failure = {
      class: 'validation_error',
      detail: 'invalid input: my essay',
      retryable: false,
      resetAt: null,
    } as const
    expect(describeEvent({ type: 'turn.ended', threadId: 't1', turnId: 'turn-1', status: 'failed', failure })).toEqual({
      type: 'turn.ended',
      threadId: 't1',
      turnId: 'turn-1',
      status: 'failed',
      failureClass: 'validation_error',
    })
    expect(describeEvent({ type: 'notice', message: 'Could not read my essay' })).toEqual({ type: 'notice' })
  })
})
