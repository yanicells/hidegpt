import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { afterAll, describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as TestClock from 'effect/testing/TestClock'

import { layer, parseProcessTable, ProcessLedger, run, startOf, type LedgerEntry, type LedgerOptions, type ProcessRow } from './ProcessLedger'

/** Real processes and files: the ledger's job is the boundary with the OS. */
const dir = mkdtempSync(join(tmpdir(), 'hidegpt-ledger-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const freshPath = () => join(mkdtempSync(join(dir, 'case-')), `ledger-${(files += 1)}.json`)

const withLedger = <A, E>(path: string, options: LedgerOptions, use: (ledger: ProcessLedger['Service']) => Effect.Effect<A, E>) =>
  Effect.flatMap(Effect.service(ProcessLedger), use).pipe(Effect.provide(layer(path, options)), Effect.provide(NodeServices.layer))
const reap = (path: string, options: LedgerOptions = {}) => withLedger(path, options, (ledger) => ledger.reap)

const onDisk = (path: string): Record<string, LedgerEntry> => JSON.parse(readFileSync(path, 'utf8'))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const started: ChildProcess[] = []
/** A detached process leading its own group, as the supervisor spawns servers. */
const launch = (command: string, args: ReadonlyArray<string>, stdin: 'ignore' | 'pipe' = 'ignore') => {
  const child = spawn(command, [...args], { detached: true, stdio: [stdin, 'ignore', 'ignore'] })
  started.push(child)
  return child
}
const sleeper = () => launch('/bin/sleep', ['30']).pid ?? 0
const exited = (child: ChildProcess) =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) resume(Effect.void)
    else child.once('exit', () => resume(Effect.void))
  })
afterAll(() => {
  for (const child of started) {
    try {
      process.kill(-(child.pid ?? 0), 'SIGKILL')
    } catch {
      // already gone
    }
  }
})

const processTableNow = () =>
  parseProcessTable(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,command='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }))

/** A main process that crashed: its pid and start time no longer run. */
const GONE = { owner: 2, ownerStarted: Date.UTC(2001, 0, 1) }
/** Above every OS's pid range, so `ps` knows nothing about it. */
const NO_SUCH_PID = 2 ** 30
/** A daemon that leaves its parent's group and session, as `setsid` does; a group kill misses it. */
const DAEMON = `/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); sleep 30'`
/** A stand-in process table the test changes between reads. */
const fakeTable = (rows: () => ReadonlyArray<ProcessRow>, duringRead: () => Effect.Effect<void> = () => Effect.void) =>
  Effect.suspend(() => Effect.as(duringRead(), Option.some(rows())))
const row = (pid: number, ppid: number, started: number): ProcessRow => ({ pid, ppid, pgid: pid, started, command: '' })

const entry = (fields: Partial<LedgerEntry> & Pick<LedgerEntry, 'command' | 'started'>): LedgerEntry => ({ arg: '', members: [], ...GONE, ...fields })

describe('ProcessLedger', () => {
  it('reads pid, parent, group, a UTC start time and a command with spaces from ps', () => {
    expect(parseProcessTable('  123     1    45 Thu Nov  5 14:39:47 2026     /Applications/My App.app/claude --output-format\n junk\n')).toEqual([
      { pid: 123, ppid: 1, pgid: 45, started: Date.UTC(2026, 10, 5, 14, 39, 47), command: '/Applications/My App.app/claude --output-format' },
    ])
  })

  it('reads a table without command lines, as tracking asks for', () => {
    expect(parseProcessTable('  123     1    45 Thu Nov  5 14:39:47 2026\n')).toEqual([
      { pid: 123, ppid: 1, pgid: 45, started: Date.UTC(2026, 10, 5, 14, 39, 47), command: '' },
    ])
  })

  it.live('gives up on a command that ignores SIGTERM and holds its output open, and kills it', () => {
    const files = mkdtempSync(join(dir, 'case-'))
    const shell = join(files, 'shell')
    const held = join(files, 'held')
    // The shell ignores SIGTERM and waits on a background sleep that shares its stdout.
    const script = `sleep 30 & echo $! > ${held}; echo $$ > ${shell}; trap '' TERM; wait`
    // The sleep goes last: while it runs, only a kill can end the shell.
    const killHolder = Effect.sync(() => {
      try {
        process.kill(Number(readFileSync(held, 'utf8')), 'SIGKILL')
      } catch {
        // already gone, or never started
      }
    })
    return Effect.gen(function* () {
      const at = Date.now()
      const out = yield* run('/bin/sh', ['-c', script], 500)
      expect(Option.isNone(out)).toBe(true)
      expect(Date.now() - at).toBeLessThan(1_500)
      const pid = Number(readFileSync(shell, 'utf8'))
      for (let i = 0; i < 50 && alive(pid); i += 1) yield* Effect.sleep('20 millis')
      expect(alive(pid)).toBe(false)
    }).pipe(Effect.ensuring(killHolder))
  })

  it.effect('records start times as epoch ms, the same in every timezone', () =>
    Effect.gen(function* () {
      const pid = sleeper()
      const at = yield* startOf(pid)
      // Second resolution; a local-time reading would be off by the UTC offset.
      expect(Math.abs(at - Date.now())).toBeLessThan(5_000)
      expect(yield* startOf(NO_SUCH_PID)).toBe(0)
    }),
  )

  it.effect('kills a crashed run’s server only when its start time and full command still match', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const server = sleeper()
      // Another app's copy of the same CLI, and a pid the OS gave to an unrelated program since the crash.
      const otherApp = sleeper()
      const reused = sleeper()
      writeFileSync(
        path,
        JSON.stringify({
          [server]: entry({ command: '/bin/sleep', arg: '30', started: yield* startOf(server) }),
          [otherApp]: entry({ command: '/Users/someone/hidegpt/node_modules/sleep', arg: '30', started: yield* startOf(otherApp) }),
          [reused]: entry({ command: '/bin/sleep', arg: '30', started: (yield* startOf(reused)) - 60_000 }),
        }),
      )
      expect(yield* reap(path)).toBe(1)
      expect(alive(otherApp)).toBe(true)
      expect(alive(reused)).toBe(true)
      expect(onDisk(path)).toEqual({})
    }),
  )

  it.effect('never reaps entries whose owner (another instance) is still running', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const firstInstance = sleeper()
      const server = sleeper()
      const kept = entry({ command: '/bin/sleep', arg: '30', started: yield* startOf(server), owner: firstInstance, ownerStarted: yield* startOf(firstInstance) })
      writeFileSync(path, JSON.stringify({ [server]: kept }))
      expect(yield* reap(path)).toBe(0)
      expect(alive(server)).toBe(true)
      // The entry stays, so the first instance's own record is not lost either.
      expect(onDisk(path)[server]).toEqual(kept)
    }),
  )

  it.effect('reaps a crashed owner’s entries even when this main got its pid', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const server = sleeper()
      writeFileSync(path, JSON.stringify({ [server]: entry({ command: '/bin/sleep', arg: '30', started: yield* startOf(server), owner: process.pid }) }))
      expect(yield* reap(path)).toBe(1)
    }),
  )

  it.live('tracks a CLI’s process tree while it runs, and after a crash kills only the members it recorded', () =>
    Effect.gen(function* () {
      const path = freshPath()
      // The first instance, the CLI (it exits on stdin close, like Claude Code) and its MCP server child.
      const firstInstance = launch('/bin/sleep', ['30'])
      const cli = launch('/bin/sh', ['-c', 'sleep 30 & read line'], 'pipe')
      const cliPid = cli.pid ?? 0
      yield* Effect.sleep('200 millis')
      const firstOptions = { owner: firstInstance.pid ?? 0 }
      yield* withLedger(path, firstOptions, (ledger) => Effect.andThen(ledger.record(cliPid, '/bin/sh', '-c'), ledger.track))
      const members = onDisk(path)[cliPid]?.members ?? []
      expect(members).toHaveLength(1)
      const mcp = members[0]?.pid ?? 0

      // An unrelated program got a pid the ledger names, started its own group, and left a child running.
      const unrelated = launch('/bin/sh', ['-c', 'sleep 30 & exit 0'])
      yield* exited(unrelated)
      const unrelatedPid = unrelated.pid ?? 0
      const unrelatedChild = processTableNow().find((row) => row.pgid === unrelatedPid && row.pid !== unrelatedPid)
      expect(unrelatedChild).toBeDefined()
      const ledgerNow = onDisk(path)
      writeFileSync(path, JSON.stringify({ ...ledgerNow, [unrelatedPid]: entry({ command: '/bin/sh', arg: '-c', started: Date.now() - 60_000 }) }))

      // The first instance crashes; its CLI exits on stdin close and leaves the MCP server behind.
      firstInstance.kill('SIGKILL')
      cli.stdin?.end()
      yield* Effect.all([exited(firstInstance), exited(cli)])
      expect(alive(mcp)).toBe(true)

      expect(yield* reap(path)).toBe(1)
      for (let i = 0; i < 50 && alive(mcp); i += 1) yield* Effect.sleep('20 millis')
      expect(alive(mcp)).toBe(false)
      expect(alive(unrelatedChild?.pid ?? 0)).toBe(true)
    }),
  )

  it.live('stop kills a member that left the group once the CLI has exited, then forgets the CLI', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const cli = launch('/bin/sh', ['-c', `${DAEMON} & read line`], 'pipe')
      const cliPid = cli.pid ?? 0
      yield* Effect.sleep('300 millis')
      yield* withLedger(path, {}, (ledger) =>
        Effect.gen(function* () {
          yield* ledger.record(cliPid, '/bin/sh', '-c')
          yield* ledger.track
          const daemon = onDisk(path)[cliPid]?.members[0]?.pid ?? 0
          expect(processTableNow().find((proc) => proc.pid === daemon)?.pgid).toBe(daemon)
          // The CLI exits on its own and its group goes; the daemon is in a group of its own.
          cli.stdin?.end()
          yield* exited(cli)
          expect(alive(daemon)).toBe(true)

          yield* ledger.stop(cliPid)
          for (let i = 0; i < 50 && alive(daemon); i += 1) yield* Effect.sleep('20 millis')
          expect(alive(daemon)).toBe(false)
          expect(onDisk(path)).toEqual({})
        }),
      )
    }),
  )

  it.effect('reads a new entry’s tree within 5 s of its record', () =>
    Effect.gen(function* () {
      const leader = sleeper()
      let reads = 0
      const table = fakeTable(
        () => [],
        () => Effect.sync(() => void (reads += 1)),
      )
      yield* withLedger(freshPath(), { processTable: table }, (ledger) =>
        Effect.gen(function* () {
          // The record lands while the tracking loop is part-way through its wait.
          yield* TestClock.adjust('3 seconds')
          yield* ledger.record(leader, '/bin/sleep', '30')
          expect(reads).toBe(0)
          yield* TestClock.adjust('5 seconds')
          expect(reads).toBeGreaterThan(0)
        }),
      )
    }),
  )

  it.effect('drops a member that has exited on the next re-read', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const leader = sleeper()
      const at = yield* startOf(leader)
      let rows = [row(leader, 1, at), row(NO_SUCH_PID, leader, at)]
      yield* withLedger(path, { processTable: fakeTable(() => rows) }, (ledger) =>
        Effect.gen(function* () {
          yield* ledger.record(leader, '/bin/sleep', '30')
          yield* ledger.track
          expect(onDisk(path)[leader]?.members).toEqual([{ pid: NO_SUCH_PID, started: at }])
          rows = [row(leader, 1, at)]
          yield* ledger.track
          expect(onDisk(path)[leader]?.members).toEqual([])
        }),
      )
    }),
  )

  it.effect('an entry forgotten while its tree is being read stays forgotten', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const leader = sleeper()
      const at = yield* startOf(leader)
      let duringRead = (): Effect.Effect<void> => Effect.void
      const table = fakeTable(() => [row(leader, 1, at), row(NO_SUCH_PID, leader, at)], () => duringRead())
      yield* withLedger(path, { processTable: table }, (ledger) =>
        Effect.gen(function* () {
          yield* ledger.record(leader, '/bin/sleep', '30')
          duringRead = () => ledger.forget(leader)
          yield* ledger.track
          expect(onDisk(path)).toEqual({})
        }),
      )
    }),
  )

  it.effect('drops entries from before the last boot without killing anything', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const server = sleeper()
      const at = yield* startOf(server)
      writeFileSync(path, JSON.stringify({ [server]: entry({ command: '/bin/sleep', arg: '30', started: at }) }))
      // As if the machine booted after this entry was written.
      expect(yield* reap(path, { bootTime: at + 1_000 })).toBe(0)
      expect(alive(server)).toBe(true)
      expect(onDisk(path)).toEqual({})
    }),
  )

  it.effect('still reaps the members of an entry whose own start time is unknown', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const member = sleeper()
      const at = yield* startOf(member)
      writeFileSync(path, JSON.stringify({ [NO_SUCH_PID]: entry({ command: '/bin/sh', started: 0, members: [{ pid: member, started: at }] }) }))
      // An unknown start time says nothing about the boot, so the entry is not dropped for it.
      expect(yield* reap(path, { bootTime: at - 1_000 })).toBe(1)
      for (let i = 0; i < 50 && alive(member); i += 1) yield* Effect.sleep('20 millis')
      expect(alive(member)).toBe(false)
    }),
  )

  it.effect('leaves the ledger untouched when ps fails', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const contents = JSON.stringify({ 4242: entry({ command: 'codex', arg: 'app-server', started: Date.now() }) })
      writeFileSync(path, contents)
      expect(yield* reap(path, { processTable: Effect.succeed(Option.none()) })).toBe(0)
      expect(readFileSync(path, 'utf8')).toBe(contents)
    }),
  )

  it.effect('records the start time, and keeps another owner’s entries when it writes its own', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const server = sleeper()
      yield* withLedger(path, { owner: NO_SUCH_PID }, (ledger) => ledger.record(5001, 'codex', 'app-server'))
      yield* withLedger(path, {}, (ledger) => ledger.record(server, '/bin/sleep', '30'))
      expect(onDisk(path)).toEqual({
        5001: { command: 'codex', arg: 'app-server', started: 0, owner: NO_SUCH_PID, ownerStarted: 0, members: [] },
        [server]: { command: '/bin/sleep', arg: '30', started: yield* startOf(server), owner: process.pid, ownerStarted: yield* startOf(process.pid), members: [] },
      })
    }),
  )

  it.effect('writes atomically: concurrent records all land and no temp files remain', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const pids = Array.from({ length: 20 }, (_, i) => 6000 + i)
      yield* withLedger(path, {}, (ledger) =>
        Effect.gen(function* () {
          yield* Effect.forEach(pids, (pid) => ledger.record(pid, 'codex', 'app-server'), { concurrency: 'unbounded' })
          yield* ledger.forget(6000)
        }),
      )
      expect(Object.keys(onDisk(path)).map(Number).sort()).toEqual(pids.slice(1))
      expect(readdirSync(join(path, '..'))).toEqual([path.split('/').at(-1)])
    }),
  )

  it.effect('treats corrupt or old-format JSON as empty and rewrites it', () =>
    Effect.gen(function* () {
      const oldFormat = { binary: 'codex', arg: 'app-server', started: 'Thu Nov 12 14:39:47 2026', owner: 1, ownerStarted: '' }
      for (const corrupt of ['{not json', JSON.stringify({ 4242: 'codex app-server' }), JSON.stringify({ 4242: oldFormat })]) {
        const path = freshPath()
        writeFileSync(path, corrupt)
        yield* withLedger(path, { owner: NO_SUCH_PID }, (ledger) =>
          Effect.gen(function* () {
            expect(yield* ledger.reap).toBe(0)
            yield* ledger.record(4343, 'codex', 'app-server')
          }),
        )
        expect(Object.keys(onDisk(path))).toEqual(['4343'])
      }
    }),
  )

  it.effect('reaps nothing without a ledger file', () => reap(freshPath()).pipe(Effect.map((killed) => expect(killed).toBe(0))))
})
