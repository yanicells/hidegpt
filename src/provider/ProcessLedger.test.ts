import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { afterAll, describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { layer, parseProcessTable, ProcessLedger, startOf, type LedgerEntry } from './ProcessLedger'

/** Real processes and files: the ledger's job is the boundary with the OS. */
const dir = mkdtempSync(join(tmpdir(), 'hidegpt-ledger-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const freshPath = () => join(mkdtempSync(join(dir, 'case-')), `ledger-${(files += 1)}.json`)

const withLedger = <A, E>(path: string, owner: number, use: (ledger: ProcessLedger['Service']) => Effect.Effect<A, E>) =>
  Effect.flatMap(Effect.service(ProcessLedger), use).pipe(Effect.provide(layer(path, owner)), Effect.provide(NodeServices.layer))
const reap = (path: string) => withLedger(path, process.pid, (ledger) => ledger.reap)

const onDisk = (path: string): Record<string, LedgerEntry> => JSON.parse(readFileSync(path, 'utf8'))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const groupAlive = (pid: number) => alive(-pid)

/** `sleep 30` leading its own process group, as the supervisor spawns servers. */
const sleeper = (command = '/bin/sleep') => {
  const child = spawn(command, ['30'], { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid ?? 0
}
/** A main process that crashed: its pid and start time no longer run. */
const GONE = { owner: 2, ownerStarted: 'Mon Jan 1 00:00:00 2001' }
const LONG_AGO = 'Mon Jan 1 00:00:00 2001'
/** Above every OS's pid range, so `ps` knows nothing about it. */
const NO_SUCH_PID = 2 ** 30

const cleanup = (pids: ReadonlyArray<number>) => {
  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

describe('ProcessLedger', () => {
  it('reads pid, group, start time and a command with spaces from ps', () => {
    expect(parseProcessTable('  123    45 Thu Nov  5 14:39:47 2026     /Applications/My App.app/claude --output-format\n junk\n')).toEqual([
      { pid: 123, pgid: 45, started: 'Thu Nov 5 14:39:47 2026', command: '/Applications/My App.app/claude --output-format' },
    ])
  })

  it.effect('kills a crashed run’s server only when its start time and full command still match', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const server = sleeper()
      // Another app's copy of the same CLI, and a pid the OS gave to an unrelated program since the crash.
      const otherApp = sleeper()
      const reused = sleeper()
      try {
        const started = (pid: number) => startOf(pid)
        writeFileSync(
          path,
          JSON.stringify({
            [server]: { command: '/bin/sleep', arg: '30', started: yield* started(server), ...GONE },
            [otherApp]: { command: '/Users/someone/hidegpt/node_modules/sleep', arg: '30', started: yield* started(otherApp), ...GONE },
            [reused]: { command: '/bin/sleep', arg: '30', started: LONG_AGO, ...GONE },
          }),
        )
        expect(yield* reap(path)).toBe(1)
        expect(alive(otherApp)).toBe(true)
        expect(alive(reused)).toBe(true)
        expect(onDisk(path)).toEqual({})
      } finally {
        cleanup([server, otherApp, reused])
      }
    }),
  )

  it.effect('never reaps entries whose owner (another instance) is still running', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const firstInstance = sleeper()
      const server = sleeper()
      try {
        const entry = { command: '/bin/sleep', arg: '30', started: yield* startOf(server), owner: firstInstance, ownerStarted: yield* startOf(firstInstance) }
        writeFileSync(path, JSON.stringify({ [server]: entry }))
        expect(yield* reap(path)).toBe(0)
        expect(alive(server)).toBe(true)
        // The entry stays, so the first instance's own record is not lost either.
        expect(onDisk(path)[server]).toEqual(entry)
      } finally {
        cleanup([firstInstance, server])
      }
    }),
  )

  it.effect('reaps a crashed owner’s entries even when this main got its pid', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const server = sleeper()
      try {
        writeFileSync(
          path,
          JSON.stringify({ [server]: { command: '/bin/sleep', arg: '30', started: yield* startOf(server), owner: process.pid, ownerStarted: LONG_AGO } }),
        )
        expect(yield* reap(path)).toBe(1)
      } finally {
        cleanup([server])
      }
    }),
  )

  it.live('reaps a group whose leader is gone but whose members (MCP servers) remain', () =>
    Effect.gen(function* () {
      const recordedAt = yield* startOf(process.pid)
      const leaderOnly = () =>
        Effect.callback<number>((resume) => {
          const child = spawn('/bin/sh', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' })
          child.once('exit', () => resume(Effect.succeed(child.pid ?? 0)))
        })
      const orphaned = yield* leaderOnly()
      // A group that was already running before the recorded start cannot be the recorded one.
      const older = yield* leaderOnly()
      try {
        expect(groupAlive(orphaned) && groupAlive(older)).toBe(true)
        const path = freshPath()
        writeFileSync(
          path,
          JSON.stringify({
            [orphaned]: { command: '/bin/sh', arg: '-c', started: recordedAt, ...GONE },
            [older]: { command: '/bin/sh', arg: '-c', started: 'Fri Jan 1 00:00:00 2100', ...GONE },
          }),
        )
        expect(yield* reap(path)).toBe(1)
        for (let i = 0; i < 50 && groupAlive(orphaned); i += 1) yield* Effect.sleep('20 millis')
        expect(groupAlive(orphaned)).toBe(false)
        expect(groupAlive(older)).toBe(true)
      } finally {
        cleanup([orphaned, older])
      }
    }),
  )

  it.effect('records the start time, and keeps another owner’s entries when it writes its own', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const server = sleeper()
      try {
        yield* withLedger(path, NO_SUCH_PID, (ledger) => ledger.record(5001, 'codex', 'app-server'))
        yield* withLedger(path, process.pid, (ledger) => ledger.record(server, '/bin/sleep', '30'))
        expect(onDisk(path)).toEqual({
          5001: { command: 'codex', arg: 'app-server', started: '', owner: NO_SUCH_PID, ownerStarted: '' },
          [server]: { command: '/bin/sleep', arg: '30', started: yield* startOf(server), owner: process.pid, ownerStarted: yield* startOf(process.pid) },
        })
        expect(onDisk(path)[server]?.started).toMatch(/\d{4}$/)
      } finally {
        cleanup([server])
      }
    }),
  )

  it.effect('writes atomically: concurrent records all land and no temp files remain', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const pids = Array.from({ length: 20 }, (_, i) => 6000 + i)
      yield* withLedger(path, process.pid, (ledger) =>
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
      for (const corrupt of ['{not json', JSON.stringify({ 4242: 'codex app-server' })]) {
        const path = freshPath()
        writeFileSync(path, corrupt)
        yield* withLedger(path, NO_SUCH_PID, (ledger) =>
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
