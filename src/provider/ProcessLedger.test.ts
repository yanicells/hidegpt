import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { afterAll, describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { isAlive, layer, ProcessLedger } from './ProcessLedger'

/** Real processes and files: the ledger's job is the boundary with the OS. */
const dir = mkdtempSync(join(tmpdir(), 'hidegpt-ledger-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const freshPath = () => join(mkdtempSync(join(dir, 'case-')), `ledger-${(files += 1)}.json`)

const withLedger = <A, E>(path: string, owner: number, use: (ledger: ProcessLedger['Service']) => Effect.Effect<A, E>) =>
  Effect.flatMap(Effect.service(ProcessLedger), use).pipe(Effect.provide(layer(path, owner)), Effect.provide(NodeServices.layer))

const onDisk = (path: string): Record<string, { binary: string; arg: string; owner: number }> =>
  JSON.parse(readFileSync(path, 'utf8'))

/** A `sleep` in its own process group, as the supervisor spawns servers. */
const sleeper = () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid ?? 0
}
/** The pid of a process that has already exited: a main process that crashed. */
const deadPid = () => spawnSync('true').pid ?? 0

const cleanup = (pids: ReadonlyArray<number>) => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

describe('ProcessLedger', () => {
  it.effect('kills a crashed run’s server only while its command still matches', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const server = sleeper()
      const reused = sleeper()
      const crashed = deadPid()
      try {
        // `reused` stands for a PID the OS gave to an unrelated program since the crash.
        writeFileSync(
          path,
          JSON.stringify({
            [server]: { binary: 'sleep', arg: '30', owner: crashed },
            [reused]: { binary: 'opencode', arg: 'serve', owner: crashed },
          }),
        )
        expect(yield* withLedger(path, process.pid, (ledger) => ledger.reap)).toBe(1)
        expect(isAlive(reused)).toBe(true)
        expect(onDisk(path)).toEqual({})
      } finally {
        cleanup([server, reused])
      }
    }),
  )

  it.effect('never reaps entries whose owner (another instance) is still alive', () =>
    Effect.gen(function* () {
      const path = freshPath()
      const firstInstance = sleeper()
      const server = sleeper()
      try {
        writeFileSync(path, JSON.stringify({ [server]: { binary: 'sleep', arg: '30', owner: firstInstance } }))
        expect(yield* withLedger(path, process.pid, (ledger) => ledger.reap)).toBe(0)
        expect(isAlive(server)).toBe(true)
        // The entry stays, so the first instance's own record is not lost either.
        expect(onDisk(path)[server]).toMatchObject({ owner: firstInstance })
      } finally {
        cleanup([firstInstance, server])
      }
    }),
  )

  it.effect('keeps another owner’s entries when it writes its own', () =>
    Effect.gen(function* () {
      const path = freshPath()
      yield* withLedger(path, 111, (ledger) => ledger.record(5001, 'codex', 'app-server'))
      yield* withLedger(path, 222, (ledger) => ledger.record(5002, 'opencode', 'serve'))
      expect(onDisk(path)).toEqual({
        5001: { binary: 'codex', arg: 'app-server', owner: 111 },
        5002: { binary: 'opencode', arg: 'serve', owner: 222 },
      })
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
        yield* withLedger(path, process.pid, (ledger) =>
          Effect.gen(function* () {
            expect(yield* ledger.reap).toBe(0)
            yield* ledger.record(4343, 'codex', 'app-server')
          }),
        )
        expect(onDisk(path)).toEqual({ 4343: { binary: 'codex', arg: 'app-server', owner: process.pid } })
      }
    }),
  )

  it.effect('reaps nothing without a ledger file', () =>
    withLedger(freshPath(), process.pid, (ledger) => ledger.reap).pipe(Effect.map((killed) => expect(killed).toBe(0))),
  )
})
