// Adapted from T3 Code (apps/server/src/serverLogger.ts and
// apps/server/src/observability/Observability.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Path from 'effect/Path'
import * as References from 'effect/References'

import { makeRotatingFileSink } from './rotatingFileSink'

/** `logs/main.ndjson`: 10 MB, plus five rotated files. */
export const MAIN_LOG = { name: 'main.ndjson', maxBytes: 10 * 1024 * 1024, maxFiles: 5 } as const
/** Log lines are written in batches at most this far apart. */
export const BATCH_WINDOW = '250 millis'

export interface LoggingOptions {
  /** `userData/logs`. */
  readonly directory: string
  /** Also print to the terminal (development). */
  readonly console: boolean
}

/**
 * Main's logger: every `Effect.log*` becomes one JSON line in
 * `logs/main.ndjson` (Effect's structured format: message, level, timestamp,
 * cause, annotations), batched and rotated by size. Lines still buffered when
 * the runtime is disposed are flushed on the way out. Debug lines (the
 * connection timeline) are kept. If the log folder cannot be created, Docs
 * keeps running and logs to the terminal only.
 */
export const layer = (options: LoggingOptions) =>
  Layer.mergeAll(
    Layer.succeed(References.MinimumLogLevel, 'Debug'),
    Logger.layer(
      [
        Effect.gen(function* () {
          const path = yield* Path.Path
          const sink = yield* makeRotatingFileSink({ ...MAIN_LOG, filePath: path.join(options.directory, MAIN_LOG.name) })
          return yield* Logger.batched(Logger.formatJson, {
            window: BATCH_WINDOW,
            flush: (lines) => Effect.ignore(sink.write(lines.map((line) => `${line}\n`).join(''))),
          })
        }).pipe(Effect.catch(() => Effect.succeed(Logger.consolePretty()))),
        ...(options.console ? [Logger.consolePretty()] : []),
      ],
      { mergeWithExisting: false },
    ),
  )
