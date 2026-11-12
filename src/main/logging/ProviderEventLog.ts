// Adapted from T3 Code (apps/server/src/provider/EventNdjsonLogger.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Queue from 'effect/Queue'

import { foreverObserved, observed } from '../../provider/observed'
import type { AdapterEvent } from '../../provider/ProviderAdapter'
import type { ProviderId } from '../../shared/model'
import { makeRotatingFileSink, type RotatingFileSink } from './rotatingFileSink'

/** `logs/providers/<provider>.ndjson`: 5 MB, plus three rotated files each. */
export const PROVIDER_LOG = { maxBytes: 5 * 1024 * 1024, maxFiles: 3 } as const
const BATCH_WINDOW = '500 millis'
/** Lines waiting for the writer. Past this the oldest go, and the next round logs how many. */
export const MAX_QUEUED_LINES = 10_000

/**
 * What a provider reported, one JSON line per event, so "the answer stopped"
 * can be debugged after the fact. It never holds text: no prompt or answer
 * (streamed deltas are skipped entirely), no titles, no sign-in links, and no
 * error or notice sentences, which a provider may build from what was sent.
 * A record keeps the event type, the thread, turn and item ids, item kinds and
 * statuses, and a failed turn's failure class (its redacted detail goes to the
 * main log instead).
 */
export interface ProviderEventLogShape {
  readonly record: (provider: ProviderId, event: AdapterEvent) => Effect.Effect<void>
}

/** Without the layer (tests, by default) nothing is written. */
export const ProviderEventLog = Context.Reference<ProviderEventLogShape>('hidegpt/ProviderEventLog', {
  defaultValue: () => ({ record: () => Effect.void }),
})

/** The loggable part of an event, or null for events not worth a line. Exported for tests. */
export function describeEvent(event: AdapterEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'item.delta':
      return null
    case 'turn.started':
      return { type: event.type, threadId: event.threadId, turnId: event.turnId }
    case 'turn.ended':
      return {
        type: event.type,
        threadId: event.threadId,
        turnId: event.turnId,
        status: event.status,
        ...(event.failure ? { failureClass: event.failure.class } : {}),
      }
    case 'item.upserted':
      return {
        type: event.type,
        threadId: event.threadId,
        turnId: event.turnId,
        itemId: event.item.id,
        kind: event.item.kind,
        ...(event.item.kind === 'tool' ? { tool: event.item.tool, status: event.item.status } : {}),
        ...(event.item.kind === 'request' ? { request: event.item.request, status: event.item.status } : {}),
        ...(event.replaces ? { replaces: event.replaces } : {}),
      }
    case 'thread.reset':
      return {
        type: event.type,
        threadId: event.threadId,
        items: event.items.length,
        activeTurnId: event.activeTurnId,
      }
    case 'thread.renamed':
    case 'thread.closed':
      return { type: event.type, threadId: event.threadId }
    case 'invalidate':
      return { type: event.type, part: event.part }
    case 'notice':
      return { type: event.type }
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
          observed(
            sinkFor(provider).pipe(
              Effect.flatMap((sink) =>
                sink.write(
                  lines
                    .filter((line) => line.provider === provider)
                    .map((line) => line.text)
                    .join(''),
                ),
              ),
              // A log that cannot be written must never stop Docs. The operation, not the path: it names the home folder.
              Effect.catchTag('RotatingFileSinkError', (error) =>
                Effect.logWarning('Event log write failed').pipe(Effect.annotateLogs({ operation: error.operation })),
              ),
            ),
            // One provider's bad write must not cost the others theirs.
            { name: 'eventLog.write' },
          ),
        { discard: true },
      )

    const queue = yield* Queue.sliding<Line>(MAX_QUEUED_LINES)
    let dropped = 0
    const reportDrops = Effect.suspend(() => {
      if (dropped === 0) return Effect.void
      const count = dropped
      dropped = 0
      return Effect.logWarning('Event log dropped its oldest lines').pipe(Effect.annotateLogs({ dropped: count }))
    })
    const writer = yield* foreverObserved(
      Effect.uninterruptibleMask((restore) =>
        restore(Queue.takeAll(queue)).pipe(Effect.flatMap(write), Effect.andThen(reportDrops)),
      ).pipe(Effect.andThen(Effect.sleep(BATCH_WINDOW))),
      { name: 'eventLog.writer' },
    ).pipe(Effect.forkScoped)
    yield* Effect.addFinalizer(() =>
      observed(
        Fiber.interrupt(writer).pipe(
          Effect.andThen(Queue.clear(queue)),
          Effect.flatMap(write),
          Effect.andThen(reportDrops),
        ),
        { name: 'eventLog.close' },
      ),
    )

    return ProviderEventLog.of({
      record: (provider: ProviderId, event: AdapterEvent) => {
        const fields = describeEvent(event)
        if (!fields) return Effect.void
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((at) =>
            Effect.sync(() => {
              if (Queue.sizeUnsafe(queue) >= MAX_QUEUED_LINES) dropped += 1
              Queue.offerUnsafe(queue, {
                provider,
                text: `${JSON.stringify({ timestamp: new Date(at).toISOString(), provider, ...fields })}\n`,
              })
            }),
          ),
        )
      },
    })
  })

/** The real log, under `userData/logs/providers`. */
export const layer = (directory: string) => Layer.effect(ProviderEventLog, make(directory))
