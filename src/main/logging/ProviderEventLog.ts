// Adapted from T3 Code (apps/server/src/provider/EventNdjsonLogger.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Queue from 'effect/Queue'

import type { AdapterEvent } from '../../provider/ProviderAdapter'
import type { ProviderId } from '../../shared/model'
import { makeRotatingFileSink, type RotatingFileSink } from './rotatingFileSink'

/** `logs/providers/<provider>.ndjson`: 5 MB, plus three rotated files each. */
export const PROVIDER_LOG = { maxBytes: 5 * 1024 * 1024, maxFiles: 3 } as const
const BATCH_WINDOW = '500 millis'
/** Error and notice sentences are cut here; they are for diagnosis, not reading. */
const MAX_DETAIL = 500

/**
 * What a provider reported, one JSON line per event, so "the answer stopped"
 * can be debugged after the fact. It never holds what anyone wrote: no prompt
 * text, no answer text (streamed `text` deltas are skipped entirely), no
 * titles, no sign-in links. A record keeps the event type, the thread and
 * block ids, and error or notice sentences.
 */
export interface ProviderEventLogShape {
  readonly record: (provider: ProviderId, event: AdapterEvent) => Effect.Effect<void>
}

/** Without the layer (tests, by default) nothing is written. */
export const ProviderEventLog = Context.Reference<ProviderEventLogShape>('hidegpt/ProviderEventLog', {
  defaultValue: () => ({ record: () => Effect.void }),
})

const cut = (text: string) => (text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text)

/** The loggable part of an event, or null for events not worth a line. Exported for tests. */
export function describeEvent(event: AdapterEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'text':
      return null
    case 'turnStarted':
    case 'closed':
    case 'title':
      return { type: event.type, threadId: event.threadId }
    case 'turnEnded':
      return { type: event.type, threadId: event.threadId, ...(event.error ? { error: cut(event.error) } : {}) }
    case 'block':
      return {
        type: event.type,
        threadId: event.threadId,
        blockId: event.block.id,
        kind: event.block.kind,
        ...(event.replaces ? { replaces: event.replaces } : {}),
      }
    case 'resolved':
      return { type: event.type, threadId: event.threadId, blockId: event.blockId, resolved: event.resolved }
    case 'reset':
      return { type: event.type, threadId: event.threadId, blocks: event.blocks.length, streaming: event.streaming ?? false }
    case 'invalidate':
      return { type: event.type, part: event.part }
    case 'notice':
      return { type: event.type, message: cut(event.message) }
    case 'loginUrl':
      return { type: event.type, pending: event.url !== null }
  }
}

type Line = { readonly provider: ProviderId; readonly text: string }

/**
 * Writes to `directory/<provider>.ndjson`. Lines queue up and one fiber
 * writes them in batches, so logging never slows the event pump; closing the
 * layer's scope writes whatever is still queued.
 */
export const make = (directory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const sinks = new Map<ProviderId, RotatingFileSink>()
    const sinkFor = (provider: ProviderId) => {
      const open = sinks.get(provider)
      if (open) return Effect.succeed(open)
      return makeRotatingFileSink({ ...PROVIDER_LOG, filePath: path.join(directory, `${provider}.ndjson`) }).pipe(
        Effect.tap((sink) => Effect.sync(() => sinks.set(provider, sink))),
      )
    }
    const write = (lines: ReadonlyArray<Line>) =>
      Effect.forEach(
        new Set(lines.map((line) => line.provider)),
        (provider) =>
          sinkFor(provider).pipe(
            Effect.flatMap((sink) =>
              sink.write(
                lines
                  .filter((line) => line.provider === provider)
                  .map((line) => line.text)
                  .join(''),
              ),
            ),
            // A log that cannot be written must never stop Docs.
            Effect.ignore,
          ),
        { discard: true },
      )

    const queue = yield* Queue.unbounded<Line>()
    const writer = yield* Effect.uninterruptibleMask((restore) =>
      restore(Queue.takeAll(queue)).pipe(Effect.flatMap(write)),
    ).pipe(Effect.andThen(Effect.sleep(BATCH_WINDOW)), Effect.forever, Effect.forkScoped)
    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(writer).pipe(
        Effect.andThen(Queue.clear(queue)),
        Effect.flatMap(write),
        Effect.ignore,
      ),
    )

    return ProviderEventLog.of({
      record: (provider: ProviderId, event: AdapterEvent) => {
        const fields = describeEvent(event)
        if (!fields) return Effect.void
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((at) =>
            Queue.offer(queue, {
              provider,
              text: `${JSON.stringify({ timestamp: new Date(at).toISOString(), provider, ...fields })}\n`,
            }),
          ),
          Effect.asVoid,
        )
      },
    })
  })

/** The real log, under `userData/logs/providers`. */
export const layer = (directory: string) => Layer.effect(ProviderEventLog, make(directory))
