// Adapted from T3 Code (packages/shared/src/logging.ts, makeAsyncRotatingFileSink) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

export interface RotatingFileSinkOptions {
  readonly filePath: string
  /** A write that would take the file past this rotates it first. */
  readonly maxBytes: number
  /** Rotated files kept beside the live one (`<file>.1` is the newest). */
  readonly maxFiles: number
}

export class RotatingFileSinkError extends Schema.TaggedError<RotatingFileSinkError>()('RotatingFileSinkError', {
  operation: Schema.Literals(['initialize', 'read', 'write', 'rotate', 'prune']),
  filePath: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to ${this.operation} rotating log file ${this.filePath}`
  }
}

export type RotatingFileSink = {
  /** Appends `chunk`, rotating first when it would pass `maxBytes`. Writes never interleave. */
  readonly write: (chunk: string) => Effect.Effect<void, RotatingFileSinkError>
}

/**
 * An append-only file that rotates by size: `file` → `file.1` → … →
 * `file.<maxFiles>`, dropping the oldest. Leftover backups past `maxFiles`
 * (from a run with a higher limit) are pruned on open.
 */
export const makeRotatingFileSink = Effect.fnUntraced(function* (options: RotatingFileSinkOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const maxBytes = Math.max(1, options.maxBytes)
  const maxFiles = Math.max(1, options.maxFiles)
  const failure = (operation: RotatingFileSinkError['operation']) => (cause: unknown) =>
    new RotatingFileSinkError({ operation, filePath: options.filePath, cause })
  const directory = path.dirname(options.filePath)
  const basename = path.basename(options.filePath)
  yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(failure('initialize')))
  yield* Effect.gen(function* () {
    for (const entry of yield* fs.readDirectory(directory)) {
      if (!entry.startsWith(`${basename}.`)) continue
      const suffixText = entry.slice(basename.length + 1)
      const suffix = Number(suffixText)
      if (!Number.isInteger(suffix) || String(suffix) !== suffixText || suffix <= maxFiles) continue
      yield* fs.remove(path.join(directory, entry), { force: true })
    }
  }).pipe(Effect.mapError(failure('prune')))
  const readSize = fs.stat(options.filePath).pipe(
    Effect.map((stat) => Number(stat.size)),
    Effect.catch((cause) =>
      cause.reason._tag === 'NotFound' ? Effect.succeed(0) : Effect.fail(failure('read')(cause)),
    ),
  )
  let currentSize = yield* readSize
  const semaphore = yield* Semaphore.make(1)
  const rotate = Effect.gen(function* () {
    yield* fs.remove(`${options.filePath}.${maxFiles}`, { force: true })
    for (let index = maxFiles - 1; index >= 1; index--) {
      const source = `${options.filePath}.${index}`
      if (yield* fs.exists(source)) yield* fs.rename(source, `${options.filePath}.${index + 1}`)
    }
    if (yield* fs.exists(options.filePath)) yield* fs.rename(options.filePath, `${options.filePath}.1`)
    currentSize = 0
  }).pipe(Effect.mapError(failure('rotate')))
  const append = (buffer: Uint8Array) => fs.writeFile(options.filePath, buffer, { flag: 'a' })
  const write = (chunk: string) =>
    semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          const buffer = Buffer.from(chunk)
          if (buffer.length === 0) return
          if (currentSize > 0 && currentSize + buffer.length > maxBytes) yield* rotate
          yield* append(buffer).pipe(
            // The folder was deleted while Docs ran: make it again, once, and start a fresh file.
            Effect.catch((error) =>
              error.reason._tag === 'NotFound'
                ? fs.makeDirectory(directory, { recursive: true }).pipe(
                    Effect.andThen(append(buffer)),
                    Effect.tap(() => Effect.sync(() => void (currentSize = 0))),
                  )
                : Effect.fail(error),
            ),
            Effect.mapError(failure('write')),
          )
          currentSize += buffer.length
        }).pipe(
          // After a failed write, or a defect, the size on disk is the truth. The failure itself
          // goes on to the logger's flush.
          Effect.onError(() =>
            readSize.pipe(
              Effect.tap((size) => Effect.sync(() => void (currentSize = size))),
              // oxlint-disable-next-line hidegpt/no-unobserved-effect -- a logger cannot log its own failure; the size stays as it was
              Effect.ignore,
            ),
          ),
        ),
      )
      .pipe(Effect.uninterruptible)
  return { write } satisfies RotatingFileSink
})
