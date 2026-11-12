import { execFileSync } from 'node:child_process'

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

/**
 * PIDs of running provider processes, on disk, so a hard-killed main (no
 * finalizers ran) does not leave servers behind: the next launch reaps them.
 *
 * Each entry names the main process that owns it. Reaping skips entries whose
 * owner is still alive (another instance's live providers), and kills one only
 * while its command line still matches what was spawned, so a reused PID never
 * takes down an unrelated program. Writes are atomic and keep other owners'
 * entries; a file that does not decode counts as empty.
 */

const Entry = Schema.Struct({
  /** The spawned binary's file name and first argument, matched against `ps` before a kill. */
  binary: Schema.String,
  arg: Schema.String,
  /** The main process that spawned it. */
  owner: Schema.Number,
})
export type LedgerEntry = typeof Entry.Type

const LedgerFile = Schema.fromJsonString(Schema.Record(Schema.String, Entry))
const decodeLedger = Schema.decodeUnknownOption(LedgerFile)

export class ProcessLedger extends Context.Service<
  ProcessLedger,
  {
    readonly record: (pid: number, binary: string, arg: string) => Effect.Effect<void>
    readonly forget: (pid: number) => Effect.Effect<void>
    /** Kills entries left by owners that are gone, while their command still matches. Returns how many. */
    readonly reap: Effect.Effect<number>
  }
>()('hidegpt/ProcessLedger') {}

/** True while `pid` exists, including one this user may not signal. */
export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function commandMatches(pid: number, entry: LedgerEntry): boolean {
  if (process.platform === 'win32') return false
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return command.includes(entry.binary) && (!entry.arg || command.includes(entry.arg))
  } catch {
    return false
  }
}

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

/**
 * Writes through a temp file in the same folder, then renames it over the
 * target, so a crash mid-write never leaves a half-written ledger.
 * Adapted from T3 Code (packages/shared/src/atomicWrite.ts) at commit 5c6f2f12.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
const writeFileStringAtomically = (fs: FileSystem.FileSystem, path: Path.Path, filePath: string, contents: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = path.dirname(filePath)
      yield* fs.makeDirectory(directory, { recursive: true })
      // Cleanup failure must not fail a write that already landed.
      const temp = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory, prefix: `${path.basename(filePath)}.` }),
        (dir) => Effect.ignore(fs.remove(dir, { recursive: true })),
      )
      const tempPath = path.join(temp, 'contents.tmp')
      yield* fs.writeFileString(tempPath, contents)
      yield* fs.rename(tempPath, filePath)
    }),
  )

/**
 * The ledger at `filePath`; null keeps nothing (tests, demo mode). `owner` is
 * this main process; tests pass another to stand in for a second instance.
 */
export const layer = (filePath: string | null, owner: number = process.pid) =>
  Layer.effect(
    ProcessLedger,
    Effect.gen(function* () {
      if (!filePath) return ProcessLedger.of({ record: () => Effect.void, forget: () => Effect.void, reap: Effect.succeed(0) })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const ours = new Map<number, LedgerEntry>()
      // Every read-modify-write runs alone, so concurrent spawns never drop each other's entries.
      const lock = yield* Semaphore.make(1)

      const read = fs.readFileString(filePath).pipe(
        Effect.map((text) => Option.getOrElse(decodeLedger(text), () => ({}))),
        Effect.orElseSucceed((): Record<string, LedgerEntry> => ({})),
      )
      /** Other owners' entries as they are on disk, plus this process's own. */
      const write = (others: Record<string, LedgerEntry>) =>
        writeFileStringAtomically(fs, path, filePath, JSON.stringify({ ...others, ...Object.fromEntries(ours) }))
      const othersOn = (onDisk: Record<string, LedgerEntry>) =>
        Object.fromEntries(Object.entries(onDisk).filter(([, entry]) => entry.owner !== owner))
      // The ledger is best effort: a failed write never fails a spawn.
      const save = lock.withPermits(1)(Effect.ignore(Effect.flatMap(read, (onDisk) => write(othersOn(onDisk)))))

      return ProcessLedger.of({
        record: (pid, binary, arg) =>
          Effect.suspend(() => {
            ours.set(pid, { binary, arg, owner })
            return save
          }),
        forget: (pid) => Effect.suspend(() => (ours.delete(pid) ? save : Effect.void)),
        reap: lock.withPermits(1)(
          Effect.gen(function* () {
            const kept: Record<string, LedgerEntry> = {}
            let killed = 0
            for (const [pidText, entry] of Object.entries(yield* read)) {
              const pid = Number(pidText)
              if (!Number.isSafeInteger(pid) || pid <= 1 || entry.owner === owner) continue
              // A live owner (another instance) still supervises this one.
              if (isAlive(entry.owner)) kept[pidText] = entry
              else if (commandMatches(pid, entry) && killGroup(pid)) killed += 1
            }
            yield* Effect.ignore(write(kept))
            return killed
          }),
        ),
      })
    }),
  )
