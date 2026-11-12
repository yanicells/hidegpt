import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { afterAll, describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { HELPER_NAME, resolveHelper } from './helperBinary'
import { FIRST_LAUNCH_MS, nodeAt, processName } from './helperBinary.testing'
import { ProcessSupervisor, layer } from './ProcessSupervisor'

/** Real processes: the supervisor's job is the boundary with the OS, so nothing here is faked. */
const dir = mkdtempSync(join(tmpdir(), 'hidegpt-supervisor-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const withSupervisor = <A, E>(
  use: (supervisor: ProcessSupervisor['Service']) => Effect.Effect<A, E>,
  ledgerPath: string | null = null,
  helpersDirectory: string | null = null,
) =>
  Effect.gen(function* () {
    return yield* use(yield* ProcessSupervisor)
  }).pipe(Effect.provide(layer(ledgerPath, helpersDirectory).pipe(Layer.provideMerge(NodeServices.layer))))

/** Like an MCP server that daemonizes with setsid: a group kill alone misses it. */
const WITH_DAEMON = `/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); sleep 30' & wait`
const daemons: number[] = []
afterAll(() => {
  for (const pid of daemons) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
})
/** The child of `pid` that leads a group of its own, or 0. */
const daemonOf = (pid: number) => {
  const found =
    execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .find(([child, ppid, pgid]) => ppid === pid && pgid === child)?.[0] ?? 0
  if (found) daemons.push(found)
  return found
}
/** Running and not a zombie: on Linux an orphan waits for init (or the CI runner) to reap it, and still answers kill 0. */
const running = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .startsWith('Z')
  } catch {
    return false
  }
}
// Up to 6 s: a loaded CI runner can take seconds to start or reap a process.
const until = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 300 && !check(); i += 1) yield* Effect.sleep('20 millis')
    expect(check()).toBe(true)
  })

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

  it.live(
    'stops a daemon that left the server’s group when the scope closes, and leaves no record',
    () =>
      Effect.gen(function* () {
        const ledgerPath = join(dir, 'spawn-daemon-ledger.json')
        let daemon = 0
        yield* withSupervisor(
          (supervisor) =>
            Effect.scoped(
              Effect.gen(function* () {
                const { handle } = yield* supervisor.spawn({
                  provider: 'codex',
                  command: '/bin/sh',
                  args: ['-c', WITH_DAEMON],
                })
                yield* until(() => (daemon = daemonOf(handle.pid)) > 0)
              }),
            ),
          ledgerPath,
        )
        yield* until(() => !running(daemon))
        expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toEqual({})
      }),
    20_000,
  )

  it.effect('ends with the exit code and the last stderr line', () =>
    withSupervisor((supervisor) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* supervisor.spawn(
            {
              provider: 'codex',
              command: 'sh',
              args: ['-c', 'echo starting >&2; echo "Error: config.toml is invalid" >&2; exit 3'],
            },
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

  it.live('does not hold the exit back on a stderr pipe a child still has open', () =>
    withSupervisor((supervisor) =>
      Effect.scoped(
        Effect.gen(function* () {
          // The background sleep keeps stderr open after the shell exits. A clean exit (0) leaves
          // the group alone (a failing one would kill it and close the pipe); the scope's kill ends it.
          const child = yield* supervisor.spawn(
            { provider: 'codex', command: '/bin/sh', args: ['-c', 'sleep 30 & echo "Error: bad flag" >&2; exit 0'] },
            true,
          )
          const at = Date.now()
          const error = yield* Effect.flip(child.awaitExit)
          expect(Date.now() - at).toBeLessThan(1_000)
          expect(error).toMatchObject({ _tag: 'ProcessExitedError', code: 0, stderr: 'Error: bad flag' })
        }),
      ),
    ),
  )
})

describe('ProcessSupervisor.callbackSpawner', () => {
  const groupAlive = (pid: number) => {
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      return false
    }
  }

  it.live('passes the env exactly as given and drains stderr', () =>
    withSupervisor((supervisor) =>
      Effect.scoped(
        Effect.gen(function* () {
          const spawn = yield* supervisor.callbackSpawner
          let stderr = ''
          const child = spawn({
            command: 'sh',
            args: ['-c', 'printf "%s|%s" "$MARKER" "$HOME" >&2'],
            env: { MARKER: 'kept', PATH: process.env.PATH },
            onStderr: (text) => (stderr += text),
          })
          yield* Effect.callback<void>((resume) => void child.once('close', () => resume(Effect.void)))
          // Nothing from Docs' own environment (HOME) reaches the child.
          expect(stderr).toBe('kept|')
        }),
      ),
    ),
  )

  it.live('records the full command path and start time, so another app’s copy of the CLI never matches', () =>
    Effect.gen(function* () {
      const ledgerPath = join(dir, 'callback-ledger.json')
      const entries = () =>
        JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<
          string,
          { command: string; arg: string; started: number }
        >
      yield* withSupervisor(
        (supervisor) =>
          Effect.scoped(
            Effect.gen(function* () {
              const spawn = yield* supervisor.callbackSpawner
              const pid = spawn({ command: '/bin/sleep', args: ['30'], env: {} }).pid ?? 0
              yield* until(() => {
                try {
                  return entries()[pid]?.command === '/bin/sleep'
                } catch {
                  return false
                }
              })
              expect(entries()[pid]).toMatchObject({ arg: '30', started: expect.any(Number) })
            }),
          ),
        ledgerPath,
      )
      // The scope waits for the record to go, so a quit never leaves one behind.
      expect(entries()).toEqual({})
    }),
  )

  it.live('runs each child in its own group and kills the whole group when the scope closes', () =>
    Effect.gen(function* () {
      let pid = 0
      yield* withSupervisor((supervisor) =>
        Effect.scoped(
          Effect.gen(function* () {
            const spawn = yield* supervisor.callbackSpawner
            // A shell that ignores nothing, with a grandchild in its group (like an MCP server).
            const child = spawn({ command: 'sh', args: ['-c', 'sleep 30 & wait'], env: { PATH: process.env.PATH } })
            pid = child.pid ?? 0
            expect(pid).toBeGreaterThan(0)
            yield* until(() => groupAlive(pid))
          }),
        ),
      )
      yield* until(() => !groupAlive(pid))
    }),
  )

  it.live(
    'also stops a daemon that left the group, and leaves no record',
    () =>
      Effect.gen(function* () {
        const ledgerPath = join(dir, 'daemon-ledger.json')
        let daemon = 0
        yield* withSupervisor(
          (supervisor) =>
            Effect.scoped(
              Effect.gen(function* () {
                const spawn = yield* supervisor.callbackSpawner
                const child = spawn({ command: '/bin/sh', args: ['-c', WITH_DAEMON], env: {} })
                yield* until(() => (daemon = daemonOf(child.pid ?? 0)) > 0)
              }),
            ),
          ledgerPath,
        )
        yield* until(() => !running(daemon))
        expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toEqual({})
      }),
    20_000,
  )
})

describe.runIf(process.platform === 'darwin')('ProcessSupervisor under the helper name', () => {
  const sleeper = { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'] }
  let count = 0
  /** A fresh helpers folder for each test. */
  const helpersDir = () => join(dir, `helpers-${(count += 1)}`)
  const ledgerEntries = (path: string) =>
    Object.values(JSON.parse(readFileSync(path, 'utf8')) as Record<string, { command: string }>)
  /**
   * A clone that is there (its stamp matches) but will not start, as when it is removed between
   * the lookup and the spawn or a security tool refuses it: a script with no interpreter.
   */
  const brokenClone = (helpers: string) => {
    const clone = resolveHelper(process.execPath, undefined, helpers)
    writeFileSync(clone.command, '#!/hidegpt/no-such-interpreter\n')
    return clone.command
  }

  it.live(
    'starts a CLI as Docs Helper and records that path in the ledger',
    () =>
      Effect.gen(function* () {
        const ledgerPath = join(dir, 'helper-ledger.json')
        yield* withSupervisor(
          (supervisor) =>
            Effect.scoped(
              Effect.gen(function* () {
                const { handle } = yield* supervisor.spawn({ provider: 'codex', ...sleeper })
                expect(processName(handle.pid)).toBe(HELPER_NAME)
                expect(ledgerEntries(ledgerPath)).toEqual([
                  expect.objectContaining({ command: expect.stringMatching(/\/Docs Helper$/) }),
                ])
              }),
            ),
          ledgerPath,
          helpersDir(),
        )
      }),
    FIRST_LAUNCH_MS,
  )

  it.live(
    'starts an SDK’s CLI as Docs Helper too, and records that path',
    () =>
      Effect.gen(function* () {
        const ledgerPath = join(dir, 'helper-callback-ledger.json')
        yield* withSupervisor(
          (supervisor) =>
            Effect.scoped(
              Effect.gen(function* () {
                const spawn = yield* supervisor.callbackSpawner
                // A bare name on the SDK's own PATH only: the lookup reads the env the SDK passes.
                const bin = join(dir, 'sdk-bin')
                nodeAt(join(bin, 'hidegpt-sleeper'))
                const child = spawn({ ...sleeper, command: 'hidegpt-sleeper', env: { PATH: bin } })
                yield* Effect.callback<void>((resume) => void child.once('spawn', () => resume(Effect.void)))
                expect(processName(child.pid ?? 0)).toBe(HELPER_NAME)
                yield* until(() => {
                  try {
                    return ledgerEntries(ledgerPath).some(({ command }) => command.endsWith(`/${HELPER_NAME}`))
                  } catch {
                    return false
                  }
                })
              }),
            ),
          ledgerPath,
          helpersDir(),
        )
      }),
    FIRST_LAUNCH_MS,
  )

  it.live(
    'starts the original when the clone will not start, and drops that clone',
    () =>
      Effect.gen(function* () {
        const helpers = helpersDir()
        const clone = brokenClone(helpers)
        const ledgerPath = join(dir, 'helper-fallback-ledger.json')
        yield* withSupervisor(
          (supervisor) =>
            Effect.scoped(
              Effect.gen(function* () {
                const { handle } = yield* supervisor.spawn({ provider: 'codex', ...sleeper })
                expect(processName(handle.pid)).toBe('node')
                expect(ledgerEntries(ledgerPath)).toEqual([expect.objectContaining({ command: process.execPath })])
              }),
            ),
          ledgerPath,
          helpers,
        )
        // The next start makes a fresh clone.
        expect(existsSync(clone)).toBe(false)
      }),
    FIRST_LAUNCH_MS,
  )

  it.live(
    'starts an SDK’s original CLI when its clone will not start',
    () =>
      Effect.gen(function* () {
        const helpers = helpersDir()
        const clone = brokenClone(helpers)
        yield* withSupervisor(
          (supervisor) =>
            Effect.scoped(
              Effect.gen(function* () {
                const spawn = yield* supervisor.callbackSpawner
                const child = spawn({ ...sleeper, env: {} })
                yield* Effect.callback<void>((resume) => void child.once('spawn', () => resume(Effect.void)))
                expect(processName(child.pid ?? 0)).toBe('node')
              }),
            ),
          null,
          helpers,
        )
        expect(existsSync(clone)).toBe(false)
      }),
    FIRST_LAUNCH_MS,
  )
})
