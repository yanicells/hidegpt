// Adapted from T3 Code (apps/server/src/provider/EventNdjsonLogger.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'

import { ThreadEvent } from '../../provider/events'
import { foreverObserved, observed } from '../../provider/observed'
import { isThreadEvent, type AdapterEvent, type CatalogPart } from '../../provider/ProviderAdapter'
import { libraryName } from '../../shared/labels'
import { ProviderId } from '../../shared/contracts'
import { makeRotatingFileSink, type RotatingFileSink } from './rotatingFileSink'

/** `logs/activity/<library>.ndjson`: 5 MB, plus three rotated files each. */
export const ACTIVITY_LOG = { maxBytes: 5 * 1024 * 1024, maxFiles: 3 } as const
const BATCH_WINDOW = '500 millis'
/** Lines waiting for the writer. Past this the oldest go, and the next round logs how many. */
export const MAX_QUEUED_LINES = 10_000

/**
 * What each library reported, as the canonical events of `src/provider/events.ts`,
 * one JSON line each, so a turn that never ended can be replayed after the fact
 * (`scripts/replay-events.ts`). The log keeps the shape and drops the words:
 * every text value (a prompt, an answer, a command or its output, a request's
 * wording, a title, an error or notice, a sign-in link) is written as its
 * length. Ids, kinds, statuses and failure classes stay.
 */
export interface ProviderEventLogShape {
  readonly record: (provider: ProviderId, event: AdapterEvent) => Effect.Effect<void>
}

/** Without the layer (tests, by default) nothing is written. */
export const ProviderEventLog = Context.Reference<ProviderEventLogShape>('hidegpt/ProviderEventLog', {
  defaultValue: () => ({ record: () => Effect.void }),
})

/**
 * Keys whose string values are ids or fixed tags. Every other string, at any
 * depth, is written as its length: a field added to the contract later stays
 * out of the log until someone decides it is safe and lists it here.
 */
const KEPT_STRINGS: ReadonlySet<string> = new Set([
  'type',
  'threadId',
  'turnId',
  'itemId',
  'activeTurnId',
  'replaces',
  'id',
  'kind',
  'phase',
  'tool',
  'request',
  'notice',
  'status',
  'class',
  'part',
])

/**
 * Keys below which no string is kept, ids included: a question's or field's
 * id is the provider's own wording (`which_essay_topic`, an elicitation
 * property name). The reducer and the replay never need them.
 */
const NOTHING_KEPT_BELOW: ReadonlySet<string> = new Set(['fields', 'questions'])

/** The contract's own numbers. Any other number in a logged event is a text length. */
const KEPT_NUMBERS: ReadonlySet<string> = new Set(['resetAt'])

/**
 * `value` with every string written as its length, unless its key is kept and
 * no ancestor is in `NOTHING_KEPT_BELOW`. Array entries are never kept.
 */
export function textAsLength(value: unknown, key: string | null = null, keep = true): unknown {
  if (typeof value === 'string') return keep && key !== null && KEPT_STRINGS.has(key) ? value : value.length
  const below = keep && !(key !== null && NOTHING_KEPT_BELOW.has(key))
  if (Array.isArray(value)) return value.map((entry) => textAsLength(entry, null, below))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, textAsLength(entry, name, below)]))
  }
  return value
}

/** Longest placeholder a replay builds; a larger length is not one this log wrote. */
const MAX_TEXT_LENGTH = 64 * 1024 * 1024

/**
 * The inverse, for replay: each length becomes a placeholder string of that
 * length. A number where the writer keeps a string (an id, a tag), or one that
 * cannot be a length, stays a number, so the line fails to decode.
 */
function lengthAsText(value: unknown, key: string | null = null, keep = true): unknown {
  if (typeof value === 'number') {
    if (key !== null && (KEPT_NUMBERS.has(key) || (keep && KEPT_STRINGS.has(key)))) return value
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TEXT_LENGTH ? '·'.repeat(value) : value
  }
  const below = keep && !(key !== null && NOTHING_KEPT_BELOW.has(key))
  if (Array.isArray(value)) return value.map((entry) => lengthAsText(entry, null, below))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, lengthAsText(entry, name, below)]))
  }
  return value
}

/**
 * Every catalog part, so `invalidate.part` is checked at runtime and not only
 * by its type: anything else could be any text. A part missing here fails to compile.
 */
const CATALOG_PARTS: Readonly<Record<CatalogPart, true>> = {
  docs: true,
  account: true,
  projects: true,
  skills: true,
  tools: true,
}

// Encoding through the schema drops any field the contract does not declare.
const encodeThreadEvent = Schema.encodeUnknownOption(ThreadEvent)
const decodeThreadEvent = Schema.decodeUnknownOption(ThreadEvent)

/**
 * An event as it is written: encoded with the contract's schema, every text
 * value as its length. Null when the event does not match the contract
 * (`record` then logs its type and skips it).
 */
export function encodeEvent(event: AdapterEvent): unknown {
  if (isThreadEvent(event))
    return Option.getOrNull(Option.map(encodeThreadEvent(event), (encoded) => textAsLength(encoded)))
  switch (event.type) {
    case 'invalidate':
      return typeof event.part === 'string' && Object.hasOwn(CATALOG_PARTS, event.part)
        ? { type: event.type, part: event.part }
        : null
    case 'notice':
      return textAsLength({ type: event.type, message: event.message })
    case 'loginUrl':
      return textAsLength({ type: event.type, url: event.url })
  }
}

const LogLine = Schema.Struct({ timestamp: Schema.String, provider: ProviderId, event: Schema.Unknown })

export type LoggedThreadEvent = {
  readonly timestamp: string
  readonly provider: ProviderId
  readonly event: ThreadEvent
}

/**
 * Reads one written line back for replay, its text as placeholders of the
 * logged lengths. Null for library events and lines that do not decode.
 */
export function readLogLine(line: string): LoggedThreadEvent | null {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return null
  }
  return Option.getOrNull(
    Option.flatMap(Schema.decodeUnknownOption(LogLine)(json), (logged) =>
      Option.map(decodeThreadEvent(lengthAsText(logged.event)), (event) => ({ ...logged, event })),
    ),
  )
}

/** The file a library writes to: its on-screen name, so no file is named after a provider. */
export const activityFile = (provider: ProviderId) => `${libraryName(provider).toLowerCase()}.ndjson`

type Line = { readonly provider: ProviderId; readonly text: string }

/**
 * Writes to `directory/<library>.ndjson`. Lines queue up and one fiber
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
      return makeRotatingFileSink({ ...ACTIVITY_LOG, filePath: path.join(directory, activityFile(provider)) }).pipe(
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

    /**
     * Item ids per thread that already logged a delta. Only an item's first
     * delta is written, as T3 skips transient deltas: it is the one that can
     * create the item, and the rest only grow text, which the log never holds.
     */
    const streamed = new Map<string, Set<string>>()
    const worthALine = (provider: ProviderId, event: AdapterEvent): boolean => {
      if (!isThreadEvent(event)) return true
      const key = `${provider}:${event.threadId}`
      if (event.type === 'item.delta') {
        const seen = streamed.get(key) ?? new Set<string>()
        if (seen.has(event.itemId)) return false
        streamed.set(key, seen.add(event.itemId))
      } else if (event.type === 'turn.ended' || event.type === 'thread.reset' || event.type === 'thread.closed') {
        streamed.delete(key)
      }
      return true
    }

    return ProviderEventLog.of({
      record: (provider: ProviderId, event: AdapterEvent) => {
        if (!worthALine(provider, event)) return Effect.void
        const encoded = encodeEvent(event)
        if (encoded === null) {
          return Effect.logWarning('Event log skipped an event outside the contract').pipe(
            Effect.annotateLogs({ provider, event: event.type }),
          )
        }
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((at) =>
            Effect.sync(() => {
              if (Queue.sizeUnsafe(queue) >= MAX_QUEUED_LINES) dropped += 1
              Queue.offerUnsafe(queue, {
                provider,
                text: `${JSON.stringify({ timestamp: new Date(at).toISOString(), provider, event: encoded })}\n`,
              })
            }),
          ),
        )
      },
    })
  })

/**
 * Deletes `logs/providers/`, where earlier builds wrote this log as
 * `codex.ndjson`, `claude.ndjson` and so on: file names that name the
 * providers, one click from Help → Report a problem. Best effort: a failure is
 * logged by its reason (not its path, which names the home folder), never raised.
 */
export const removeOldProviderLogs = (logsDirectory: string) =>
  observed(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs
        .remove(path.join(logsDirectory, 'providers'), { recursive: true, force: true })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning('Old event log folder not removed').pipe(
              Effect.annotateLogs({ reason: error.reason._tag }),
            ),
          ),
        )
    }),
    { name: 'eventLog.removeOldFolder' },
  )

/** The real log, under `userData/logs/activity`. */
export const layer = (directory: string) => Layer.effect(ProviderEventLog, make(directory))
