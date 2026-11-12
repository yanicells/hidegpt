import { execFile } from 'node:child_process'

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
 * A pid alone proves nothing after a crash, so every entry carries the start
 * time `ps` reported for it and the command as spawned, and names its owner
 * (the main process, by pid and start time). Reaping skips entries whose owner
 * still runs (another instance's live providers) and kills a group only when
 * it is provably the one recorded:
 * - its leader runs with the recorded start time and command line, or
 * - its leader is gone but members remain (a CLI's MCP servers), all started
 *   no earlier than the leader was. A pid is never reused while a group with
 *   that id exists, so the group can only be the recorded one.
 * Anything else (a reused pid, an unreadable start time) is dropped unkilled.
 *
 * Writes are atomic and keep other owners' entries; a file that does not
 * decode counts as empty.
 */

const Entry = Schema.Struct({
  /** The command as spawned (a full path for SDK-spawned CLIs) and its first argument. */
  command: Schema.String,
  arg: Schema.String,
  /** `ps` start time of the process; empty when it could not be read (never reaped). */
  started: Schema.String,
  /** The main process that spawned it, by pid and start time. */
  owner: Schema.Number,
  ownerStarted: Schema.String,
})
export type LedgerEntry = typeof Entry.Type

const LedgerFile = Schema.fromJsonString(Schema.Record(Schema.String, Entry))
const decodeLedger = Schema.decodeUnknownOption(LedgerFile)

export class ProcessLedger extends Context.Service<
  ProcessLedger,
  {
    readonly record: (pid: number, command: string, arg: string) => Effect.Effect<void>
    readonly forget: (pid: number) => Effect.Effect<void>
    /** Kills groups left by owners that are gone, when provably the recorded ones. Returns how many. */
    readonly reap: Effect.Effect<number>
  }
>()('hidegpt/ProcessLedger') {}

/**
 * One row of `ps -A -o pid=,pgid=,lstart=,command=`; pid plus start time tells a
 * process from a reused pid.
 * Adapted from T3 Code (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts,
 * `parseClaudeProcessTable`) at commit 5c6f2f12.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
type ProcessRow = { readonly pid: number; readonly pgid: number; readonly started: string; readonly command: string }

// lstart is always five fields in the C locale: "Thu Nov 12 14:39:47 2026".
const ROW = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/

const normalizeStart = (text: string) => text.trim().split(/\s+/).join(' ')

export function parseProcessTable(table: string): ReadonlyArray<ProcessRow> {
  return table.split('\n').flatMap((line) => {
    const match = ROW.exec(line)
    if (!match) return []
    const [, pid, pgid, started, command] = match
    return [{ pid: Number(pid), pgid: Number(pgid), started: normalizeStart(started ?? ''), command: command ?? '' }]
  })
}

/** "Thu Nov 12 14:39:47 2026" as epoch ms (local time), or NaN. */
const startMillis = (started: string) => {
  const [, month, day, time, year] = started.split(' ')
  return Date.parse(`${month} ${day} ${year} ${time}`)
}

/** `ps` output, or empty when it fails (no such pid, or no `ps`). */
const ps = (args: ReadonlyArray<string>) =>
  Effect.callback<string>((resume) => {
    execFile('ps', [...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) =>
      resume(Effect.succeed(error ? '' : stdout)),
    )
  })

/** The `ps` start time of `pid`, normalized; empty when it is gone. */
export const startOf = (pid: number) => Effect.map(ps(['-o', 'lstart=', '-p', String(pid)]), normalizeStart)

const processTable = Effect.map(ps(['-A', '-o', 'pid=,pgid=,lstart=,command=']), parseProcessTable)

/** Whether `entry`'s group is provably the one recorded (see the module comment). */
function isRecordedGroup(pid: number, entry: LedgerEntry, rows: ReadonlyArray<ProcessRow>): boolean {
  if (!entry.started) return false
  const leader = rows.find((row) => row.pid === pid)
  if (leader) {
    return leader.started === entry.started && leader.command.includes(entry.command) && (!entry.arg || leader.command.includes(entry.arg))
  }
  const since = startMillis(entry.started)
  const members = rows.filter((row) => row.pgid === pid)
  return members.length > 0 && !Number.isNaN(since) && members.every((row) => startMillis(row.started) >= since)
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
      const ownerStarted = yield* startOf(owner)
      const isOurs = (entry: LedgerEntry) => entry.owner === owner && entry.ownerStarted === ownerStarted
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
        Object.fromEntries(Object.entries(onDisk).filter(([, entry]) => !isOurs(entry)))
      // The ledger is best effort: a failed write never fails a spawn.
      const save = lock.withPermits(1)(Effect.ignore(Effect.flatMap(read, (onDisk) => write(othersOn(onDisk)))))

      return ProcessLedger.of({
        record: (pid, command, arg) =>
          Effect.flatMap(startOf(pid), (started) => {
            ours.set(pid, { command, arg, started, owner, ownerStarted })
            return save
          }),
        forget: (pid) => Effect.suspend(() => (ours.delete(pid) ? save : Effect.void)),
        reap: lock.withPermits(1)(
          Effect.gen(function* () {
            const rows = yield* processTable
            // An owner runs while its pid does with the same start time; an unknown start time counts as running.
            const ownerRuns = (entry: LedgerEntry) =>
              rows.some((row) => row.pid === entry.owner && (!entry.ownerStarted || row.started === entry.ownerStarted))
            const kept: Record<string, LedgerEntry> = {}
            let killed = 0
            for (const [pidText, entry] of Object.entries(yield* read)) {
              const pid = Number(pidText)
              if (!Number.isSafeInteger(pid) || pid <= 1 || isOurs(entry)) continue
              if (ownerRuns(entry)) kept[pidText] = entry
              else if (isRecordedGroup(pid, entry, rows) && killGroup(pid)) killed += 1
            }
            yield* Effect.ignore(write(kept))
            return killed
          }),
        ),
      })
    }),
  )
