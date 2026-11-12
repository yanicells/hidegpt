import { execFile } from 'node:child_process'
import { readFile } from 'node:fs'

import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
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
 * A pid alone proves nothing after a crash, so a process is only ever killed
 * when it is still provably the one recorded: the same pid *and* the same start
 * time (epoch ms, from `ps` in UTC). Each entry keeps
 * - its leader (the spawned CLI): pid, start time, and the command as spawned (a
 *   full path for SDK-spawned CLIs, so another app's copy never matches);
 * - its members: the leader's process tree (MCP servers, tools), re-read every
 *   `TRACK_EVERY` while it runs, as T3 Code tracks a CLI's descendants;
 * - its owner: the main process, by pid and start time.
 *
 * When a process ends normally, `stop` re-reads its tree once more, kills the
 * members that are still the recorded processes (a daemon that left the group
 * with `setsid` survives the group kill otherwise), and forgets it, as T3 Code's
 * `trackDescendants().stop` does. A normal exit and a crash (through `reap`)
 * kill the same processes.
 *
 * Reaping keeps entries whose owner still runs (another instance's providers),
 * drops entries from before the last boot, kills the leader's group when the
 * leader still runs with its recorded start time and command, and kills each
 * recorded member that still runs. A group whose leader is gone is never killed
 * as a group: its pid may since have been reused by an unrelated program whose
 * own children outlive it. After a crash, members that started after the last
 * re-read leak.
 *
 * Writes are atomic and keep other owners' entries; a file that does not decode
 * counts as empty, and a `ps` that fails leaves the file as it is.
 */

/**
 * How often live entries' process trees are re-read, only while there are any.
 * It bounds what a crash, or a CLI that exits on its own, can miss. Each read is
 * one `ps -A` without command lines (about 35 KB, 20-40 ms: under 1% of a core).
 */
const TRACK_EVERY = Duration.seconds(5)
/** `ps` and `sysctl` that hang must not hold up startup (`startOf`, `reap`); T3 Code uses the same. */
const COMMAND_TIMEOUT_MS = 5_000

const Member = Schema.Struct({ pid: Schema.Number, started: Schema.Number })
const Entry = Schema.Struct({
  /** The command as spawned and its first argument, matched against the leader's command line. */
  command: Schema.String,
  arg: Schema.String,
  /** Start time in epoch ms; 0 when it could not be read (never killed). */
  started: Schema.Number,
  /** The main process that spawned it, by pid and start time. */
  owner: Schema.Number,
  ownerStarted: Schema.Number,
  members: Schema.Array(Member),
})
export type LedgerEntry = typeof Entry.Type

const LedgerFile = Schema.fromJsonString(Schema.Record(Schema.String, Entry))
const decodeLedger = Schema.decodeUnknownOption(LedgerFile)

export class ProcessLedger extends Context.Service<
  ProcessLedger,
  {
    readonly record: (pid: number, command: string, arg: string) => Effect.Effect<void>
    readonly forget: (pid: number) => Effect.Effect<void>
    /** Kills the members of `pid`'s tree that still run as recorded, then forgets it. For a process that has ended or is being killed. */
    readonly stop: (pid: number) => Effect.Effect<void>
    /** Re-reads the process tree of every live entry; also runs on its own every `TRACK_EVERY`. */
    readonly track: Effect.Effect<void>
    /** Kills what crashed owners left, when provably the recorded processes. Returns how many entries. */
    readonly reap: Effect.Effect<number>
  }
>()('hidegpt/ProcessLedger') {}

/**
 * One row of `ps -A -o pid=,ppid=,pgid=,lstart=[,command=]`.
 * Adapted from T3 Code (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts,
 * `parseClaudeProcessTable`, `claudeDescendants`, `trackDescendants`) at commit 5c6f2f12.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
export type ProcessRow = {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  /** Epoch ms; 0 when unreadable. */
  readonly started: number
  /** Empty when the table was read without command lines. */
  readonly command: string
}

// lstart is always five fields in the C locale: "Thu Nov 12 14:39:47 2026", here in UTC.
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)(?:\s+(.*))?$/

/** A UTC `lstart` as epoch ms (exact to the second), or 0. */
const lstartMillis = (text: string) => {
  const [, month, day, time, year] = text.trim().split(/\s+/)
  const ms = Date.parse(`${month} ${day} ${year} ${time} UTC`)
  return Number.isNaN(ms) ? 0 : ms
}

export function parseProcessTable(table: string): ReadonlyArray<ProcessRow> {
  return table.split('\n').flatMap((line) => {
    const match = ROW.exec(line)
    if (!match) return []
    const [, pid, ppid, pgid, started, command] = match
    return [
      {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        started: lstartMillis(started ?? ''),
        command: command ?? '',
      },
    ]
  })
}

/** A command's stdout, or none when it fails. */
const run = (command: string, args: ReadonlyArray<string>) =>
  Effect.callback<Option.Option<string>>((resume) => {
    execFile(
      command,
      [...args],
      // C locale and UTC, so start times parse the same on every machine; a big table must fit.
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, maxBuffer: 16 * 1024 * 1024, timeout: COMMAND_TIMEOUT_MS },
      (error, stdout) => resume(Effect.succeed(error ? Option.none() : Option.some(stdout))),
    )
  })

/** The start time of `pid` in epoch ms; 0 when it is gone. */
export const startOf = (pid: number) =>
  Effect.map(run('ps', ['-o', 'lstart=', '-p', String(pid)]), (out) =>
    Option.match(out, { onNone: () => 0, onSome: lstartMillis }),
  )

/** Every process, or none when `ps` fails or lists nothing. Command lines only when asked: they are most of the output. */
const readProcessTable = (withCommands: boolean) =>
  Effect.map(run('ps', ['-A', '-o', `pid=,ppid=,pgid=,lstart=${withCommands ? ',command=' : ''}`]), (out) =>
    Option.filter(Option.map(out, parseProcessTable), (rows) => rows.length > 0),
  )

/** When this machine booted, in epoch ms; 0 when unknown (nothing is dropped for it). */
const readBootTime = Effect.gen(function* () {
  if (process.platform === 'darwin') {
    const out = yield* run('sysctl', ['-n', 'kern.boottime'])
    const sec = Option.getOrUndefined(out)?.match(/sec = (\d+)/)?.[1]
    return sec ? Number(sec) * 1000 : 0
  }
  if (process.platform !== 'linux') return 0
  const stat = yield* Effect.callback<string>((resume) =>
    readFile('/proc/stat', 'utf8', (error, text) => resume(Effect.succeed(error ? '' : text))),
  )
  const sec = /^btime (\d+)$/m.exec(stat)?.[1]
  return sec ? Number(sec) * 1000 : 0
})

const identity = (proc: { readonly pid: number; readonly started: number }) => `${proc.pid}@${proc.started}`

/**
 * An entry's members after a fresh read: the recorded ones still running, plus
 * everything now under them and under the leader while it runs. After the
 * leader exits its pid may belong to an unrelated process, so only tracked
 * members are roots then.
 */
function refreshMembers(
  pid: number,
  entry: LedgerEntry,
  rows: ReadonlyArray<ProcessRow>,
): ReadonlyArray<typeof Member.Type> {
  const running = new Set(rows.map(identity))
  const leaderRuns = entry.started > 0 && running.has(identity({ pid, started: entry.started }))
  const still = entry.members.filter((member) => running.has(identity(member)))
  const roots = [...(leaderRuns ? [pid] : []), ...still.map((member) => member.pid)]
  const found = descendants(rows, roots).filter((row) => row.started > 0)
  return [
    ...new Map([...still, ...found].map((row) => [identity(row), { pid: row.pid, started: row.started }])).values(),
  ]
}

/** Processes under `roots`, by parent pid. */
function descendants(rows: ReadonlyArray<ProcessRow>, roots: ReadonlyArray<number>): ReadonlyArray<ProcessRow> {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const siblings = children.get(row.ppid)
    if (siblings) siblings.push(row)
    else children.set(row.ppid, [row])
  }
  const found: ProcessRow[] = []
  const seen = new Set<number>(roots)
  const pending = [...roots]
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      pending.push(child.pid)
    }
  }
  return found
}

const signal = (target: number) => {
  try {
    process.kill(target, 'SIGKILL')
    return true
  } catch {
    return false
  }
}
/** A member that leads its own group takes the processes it started with it (as in T3 Code). */
const killRow = (row: ProcessRow) => signal(row.pgid === row.pid ? -row.pid : row.pid)

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

export type LedgerOptions = {
  /** This main process; tests pass another to stand in for a second instance. */
  readonly owner?: number
  /** Tests stand in for `ps` (with or without command lines) and the boot clock. */
  readonly processTable?: Effect.Effect<Option.Option<ReadonlyArray<ProcessRow>>>
  readonly bootTime?: number
}

/** The ledger at `filePath`; null keeps nothing (tests, demo mode). */
export const layer = (filePath: string | null, options: LedgerOptions = {}) =>
  Layer.effect(
    ProcessLedger,
    Effect.gen(function* () {
      if (!filePath) {
        return ProcessLedger.of({
          record: () => Effect.void,
          forget: () => Effect.void,
          stop: () => Effect.void,
          track: Effect.void,
          reap: Effect.succeed(0),
        })
      }
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const owner = options.owner ?? process.pid
      const trackingTable = options.processTable ?? readProcessTable(false)
      const fullTable = options.processTable ?? readProcessTable(true)
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

      const track = Effect.gen(function* () {
        if (ours.size === 0) return
        const table = yield* trackingTable
        if (Option.isNone(table)) return
        let changed = false
        for (const [pid, entry] of ours) {
          const members = refreshMembers(pid, entry, table.value)
          const before = entry.members.map(identity).sort().join()
          if (members.map(identity).sort().join() === before) continue
          // Nothing yields between the read above and here, so an entry forgotten during the read is not in `ours`.
          ours.set(pid, { ...entry, members })
          changed = true
        }
        if (changed) yield* save
      })
      yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(TRACK_EVERY), track)))

      return ProcessLedger.of({
        record: (pid, command, arg) =>
          Effect.flatMap(startOf(pid), (started) => {
            ours.set(pid, { command, arg, started, owner, ownerStarted, members: [] })
            return save
          }),
        forget: (pid) => Effect.suspend(() => (ours.delete(pid) ? save : Effect.void)),
        stop: (pid) =>
          Effect.gen(function* () {
            if (!ours.has(pid)) return
            // Without a process table nothing can be checked, so nothing is killed; it is forgotten all the same.
            const table = yield* trackingTable
            const entry = ours.get(pid)
            if (entry && Option.isSome(table)) {
              const byIdentity = new Map(table.value.map((row) => [identity(row), row]))
              for (const member of refreshMembers(pid, entry, table.value)) {
                const row = byIdentity.get(identity(member))
                if (row) killRow(row)
              }
            }
            if (ours.delete(pid)) yield* save
          }),
        track,
        reap: lock.withPermits(1)(
          Effect.gen(function* () {
            const table = yield* fullTable
            // Without a process table nothing can be checked, so the ledger stays as it is.
            if (Option.isNone(table)) return 0
            const bootTime = options.bootTime ?? (yield* readBootTime)
            const byPid = new Map(table.value.map((row) => [row.pid, row]))
            const runningAs = (pid: number, started: number) => {
              const row = byPid.get(pid)
              return started > 0 && row?.started === started ? row : undefined
            }
            // An owner runs while its pid does with the same start time; an unknown start time counts as running.
            const ownerRuns = (entry: LedgerEntry) =>
              entry.ownerStarted > 0 ? runningAs(entry.owner, entry.ownerStarted) !== undefined : byPid.has(entry.owner)
            const kept: Record<string, LedgerEntry> = {}
            let killed = 0
            for (const [pidText, entry] of Object.entries(yield* read)) {
              const pid = Number(pidText)
              if (!Number.isSafeInteger(pid) || pid <= 1 || isOurs(entry)) continue
              // Recorded before this boot: every pid in it now names something else. An unknown start time says nothing.
              if (bootTime > 0 && entry.started > 0 && entry.started < bootTime) continue
              if (ownerRuns(entry)) {
                kept[pidText] = entry
                continue
              }
              const leader = runningAs(pid, entry.started)
              const leaderMatches =
                leader !== undefined &&
                leader.command.includes(entry.command) &&
                (!entry.arg || leader.command.includes(entry.arg))
              let hit = leaderMatches && signal(-pid)
              for (const member of entry.members) {
                const row = runningAs(member.pid, member.started)
                if (row && killRow(row)) hit = true
              }
              if (hit) killed += 1
            }
            yield* Effect.ignore(write(kept))
            return killed
          }),
        ),
      })
    }),
  )
