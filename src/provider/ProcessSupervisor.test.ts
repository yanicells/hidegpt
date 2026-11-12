import { spawn as spawnChild } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { afterAll, describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { ProcessLedger, ProcessSupervisor, layer } from './ProcessSupervisor'

/** Real processes: the supervisor's job is the boundary with the OS, so nothing here is faked. */
const dir = mkdtempSync(join(tmpdir(), 'hidegpt-supervisor-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const withSupervisor = <A, E>(use: (supervisor: ProcessSupervisor['Service']) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* ProcessSupervisor)
  }).pipe(Effect.provide(layer(null).pipe(Layer.provideMerge(NodeServices.layer))))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A `sleep` in its own process group, as the supervisor spawns servers. */
const sleeper = () => {
  const child = spawnChild('sleep', ['30'], { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid ?? 0
}

describe('ProcessSupervisor', () => {
  it.effect('reports a command that is not on PATH as not installed', () =>
    withSupervisor((supervisor) =>
      Effect.flip(Effect.scoped(supervisor.spawn({ provider: 'codex', command: 'hidegpt-no-such-binary', args: [] }))),
    ).pipe(
      Effect.map((error) => {
        expect(error._tag).toBe('BinaryMissingError')
        expect(error.message).toMatch(/Codex is not installed/)
      }),
    ),
  )

  it.effect('says what failed when the command exists but cannot run', () =>
    Effect.gen(function* () {
      const script = join(dir, 'not-executable')
      writeFileSync(script, '#!/bin/sh\n')
      chmodSync(script, 0o644)
      const error = yield* withSupervisor((supervisor) =>
        Effect.flip(Effect.scoped(supervisor.spawn({ provider: 'opencode', command: script, args: [] }))),
      )
      expect(error._tag).toBe('ProviderRequestError')
      expect(error.message).toMatch(/^Docs could not start OpenCode: /)
    }),
  )

  it.effect('ends with the exit code and the last stderr line', () =>
    withSupervisor((supervisor) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* supervisor.spawn(
            { provider: 'codex', command: 'sh', args: ['-c', 'echo starting >&2; echo "Error: config.toml is invalid" >&2; exit 3'] },
            true,
          )
          return yield* Effect.flip(child.awaitExit)
        }),
      ),
    ).pipe(
      Effect.map((error) => {
        expect(error).toMatchObject({ _tag: 'ProcessExitedError', code: 3, stderr: 'Error: config.toml is invalid' })
      }),
    ),
  )
})

describe('ProcessLedger', () => {
  it('kills a previous run’s server only while its command still matches', () => {
    const path = join(dir, 'ledger.json')
    const server = sleeper()
    const reused = sleeper()
    try {
      // `reused` stands for a PID the OS gave to an unrelated program since the crash.
      writeFileSync(path, JSON.stringify({ [server]: 'sleep 30', [reused]: 'opencode serve' }))
      expect(new ProcessLedger(path).reap()).toBe(1)
      expect(alive(reused)).toBe(true)
    } finally {
      for (const pid of [server, reused]) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  })

  it('records and forgets live entries, and reaps nothing without a ledger file', () => {
    const path = join(dir, 'fresh.json')
    const ledger = new ProcessLedger(path)
    expect(ledger.reap()).toBe(0)
    ledger.record(4242, 'codex app-server')
    ledger.forget(4242)
    expect(new ProcessLedger(path).reap()).toBe(0)
  })
})
