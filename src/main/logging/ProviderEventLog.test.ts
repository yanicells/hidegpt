import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import * as CodexAdapter from '../../codex/CodexAdapter'
import { makeFakeCodex } from '../../codex/FakeCodex'
import type { Failure, Item } from '../../provider/events'
import { fromLegacy } from '../../provider/legacyEvents'
import { isThreadEvent, type AdapterEvent } from '../../provider/ProviderAdapter'
import { layerAdapters } from '../ProviderRegistry'
import * as Manager from '../ProviderSessionManager'
import { encodeEvent, layer, readLogLine } from './ProviderEventLog'

/** Planted in every text field; it must never reach a line. */
const SECRET = 'Secret-5f2a my essay'

const failure: Failure = {
  class: 'usage_limit',
  detail: `limit hit for ${SECRET}`,
  retryable: true,
  resetAt: 1_700_000,
}
const items: ReadonlyArray<Item> = [
  { kind: 'user', id: 'u1', text: SECRET, images: [`/Users/me/${SECRET}.png`], skills: [SECRET] },
  { kind: 'assistant', id: 'a1', text: SECRET, phase: 'final' },
  {
    kind: 'tool',
    id: 't1',
    tool: 'command',
    status: 'completed',
    subject: `cat ${SECRET}`,
    output: SECRET,
    legacy: { title: SECRET },
  },
  {
    kind: 'request',
    id: 'r1',
    request: 'user_input',
    status: 'pending',
    subject: SECRET,
    detail: SECRET,
    fields: [{ id: 'f1', label: SECRET, initial: SECRET }],
    questions: [{ id: 'q1', question: SECRET, options: [SECRET], allowText: true }],
    legacy: { title: SECRET },
  },
  { kind: 'notice', id: 'n1', notice: 'warning', detail: SECRET },
]

/** One of every event, with text in every field that can hold it. */
const events: ReadonlyArray<AdapterEvent> = [
  { type: 'turn.started', threadId: 'thr_1', turnId: 'turn-1' },
  ...items.map((item) => ({
    type: 'item.upserted' as const,
    threadId: 'thr_1',
    turnId: 'turn-1',
    item,
    replaces: 'local-1',
  })),
  {
    type: 'item.delta',
    threadId: 'thr_1',
    itemId: 't2',
    delta: SECRET,
    create: {
      kind: 'tool',
      id: 't2',
      tool: 'other',
      status: 'running',
      subject: null,
      output: '',
      legacy: { title: SECRET },
    },
  },
  { type: 'turn.ended', threadId: 'thr_1', turnId: 'turn-1', status: 'failed', failure },
  { type: 'thread.reset', threadId: 'thr_1', items, activeTurnId: null },
  { type: 'thread.renamed', threadId: 'thr_1', title: SECRET },
  { type: 'thread.closed', threadId: 'thr_1' },
  { type: 'invalidate', part: 'docs' },
  { type: 'notice', message: SECRET },
  { type: 'loginUrl', url: `https://auth.example/?state=${SECRET}` },
]

const line = (event: unknown) => JSON.stringify({ timestamp: '2026-11-12T00:00:00.000Z', provider: 'codex', event })

describe('ProviderEventLog', () => {
  it('writes every text field as its length, and keeps ids, kinds, statuses and the failure class', () => {
    for (const event of events) expect(JSON.stringify(encodeEvent(event))).not.toContain('Secret')

    expect(encodeEvent(events[1]!)).toEqual({
      type: 'item.upserted',
      threadId: 'thr_1',
      turnId: 'turn-1',
      replaces: 'local-1',
      item: {
        kind: 'user',
        id: 'u1',
        text: SECRET.length,
        images: [`/Users/me/${SECRET}.png`.length],
        skills: [SECRET.length],
      },
    })
    expect(encodeEvent(events.find((event) => event.type === 'turn.ended')!)).toMatchObject({
      status: 'failed',
      failure: { class: 'usage_limit', detail: failure.detail.length, retryable: true, resetAt: 1_700_000 },
    })
    expect(encodeEvent({ type: 'loginUrl', url: null })).toEqual({ type: 'loginUrl', url: null })
  })

  it('drops fields the contract does not declare', () => {
    const extra = { type: 'thread.closed', threadId: 'thr_1', raw: SECRET } as AdapterEvent
    expect(encodeEvent(extra)).toEqual({ type: 'thread.closed', threadId: 'thr_1' })
  })

  it('reads a line back as the same event, its text as placeholders of the same length', () => {
    for (const event of events) {
      const read = readLogLine(line(encodeEvent(event)))
      if (!isThreadEvent(event)) {
        expect(read).toBeNull()
        continue
      }
      expect(read?.provider).toBe('codex')
      expect(encodeEvent(read!.event)).toEqual(encodeEvent(event))
    }
    expect(readLogLine('{"timestamp":')).toBeNull()
  })

  it.effect('a session writes to the library file: no prompt or answer, and one delta per item', () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), 'docs-activity-'))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
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
      expect(log).not.toContain('Prompt-4b9d')
      expect(log).not.toContain('Answer-7c1e')
      const lines = log
        .trim()
        .split('\n')
        .map((text) => JSON.parse(text))
      expect(lines.every((entry) => entry.provider === 'codex')).toBe(true)
      const types = lines.map((entry) => entry.event.type)
      expect(types).toEqual(expect.arrayContaining(['turn.started', 'item.upserted', 'turn.ended']))
      // The answer streamed word by word; only its first delta, which creates the item, is written.
      expect(types.filter((type) => type === 'item.delta')).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
