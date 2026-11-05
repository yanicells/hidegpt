import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import * as Ref from 'effect/Ref'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import type { ProviderId } from '../shared/model'
import { appendStderrTail, stderrExcerpt } from '../vendor/effect-codex-app-server/_internal/stdio'
import { BinaryMissingError, ProcessExitedError } from './errors'

/**
 * Starts provider processes. Effect's Node spawner already gives each child
 * its own process group and, when the owning `Scope` closes, sends SIGTERM to
 * the whole group and SIGKILL after `forceKillAfter`. This service adds what
 * HideGPT needs on top: a `BinaryMissingError` for a missing CLI, a typed
 * `ProcessExitedError`, an 8 KiB stderr tail, and an orphan ledger so a
 * hard-killed Electron main (no finalizers ran) does not leave servers behind:
 * the next launch reaps them. (T3 Code gets the same guarantee by having its
 * server watch its launcher; HideGPT's main *is* the launcher.)
 */

export type SpawnOptions = {
  readonly provider: ProviderId
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
}

export interface SupervisedProcess {
  readonly handle: ChildProcessSpawner.ChildProcessHandle
  /** Fails with the exit (and the last stderr line, when tailed) once the process ends. */
  readonly awaitExit: Effect.Effect<never, ProcessExitedError>
}

/** SIGTERM first; a server that ignores it gets SIGKILL after this long. */
export const FORCE_KILL_AFTER = Duration.seconds(2)

export class ProcessSupervisor extends Context.Service<
  ProcessSupervisor,
  {
    /** Spawns in the caller's scope; closing the scope kills the process group. */
    readonly spawn: (
      options: SpawnOptions,
      tailStderr?: boolean,
    ) => Effect.Effect<SupervisedProcess, BinaryMissingError, Scope.Scope>
    /** Kills servers a previous, crashed run left behind. */
    readonly reapOrphans: Effect.Effect<number>
  }
>()('hidegpt/ProcessSupervisor') {}

const signalFrom = (error: PlatformError.PlatformError): string | null =>
  /signal: '([A-Z0-9]+)'/.exec(error.message)?.[1] ?? null

const isNotFound = (error: PlatformError.PlatformError) =>
  error.reason._tag === 'NotFound' || /ENOENT/.test(error.message)

const make = (spawner: ChildProcessSpawner.ChildProcessSpawner['Service'], ledger: ProcessLedger) =>
  ProcessSupervisor.of({
    spawn: Effect.fn('ProcessSupervisor.spawn')(function* (options, tailStderr = false) {
      const command = ChildProcess.make(options.command, [...options.args], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env, extendEnv: true } : {}),
        forceKillAfter: FORCE_KILL_AFTER,
      })
      const handle = yield* spawner.spawn(command).pipe(
        Effect.mapError((error) =>
          isNotFound(error)
            ? new BinaryMissingError({ provider: options.provider, command: options.command })
            : new BinaryMissingError({ provider: options.provider, command: `${options.command} (${error.message})` }),
        ),
      )
      const signature = `${basename(options.command)} ${options.args[0] ?? ''}`.trim()
      yield* Effect.acquireRelease(
        Effect.sync(() => ledger.record(handle.pid, signature)),
        () => Effect.sync(() => ledger.forget(handle.pid)),
      )

      const tail = yield* Ref.make('')
      if (tailStderr) {
        yield* handle.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => Ref.update(tail, (current) => appendStderrTail(current, chunk))),
          Effect.ignore,
          Effect.forkScoped,
        )
      }
      const exited = (code: number | null, signal: string | null) =>
        Effect.flatMap(Ref.get(tail), (text) => {
          const stderr = stderrExcerpt(text)
          return Effect.fail(
            new ProcessExitedError({ provider: options.provider, code, signal, ...(stderr ? { stderr } : {}) }),
          )
        })
      const awaitExit: Effect.Effect<never, ProcessExitedError> = handle.exitCode.pipe(
        Effect.matchEffect({
          onSuccess: (code) => exited(code, null),
          onFailure: (error) => exited(null, signalFrom(error)),
        }),
      )
      return { handle, awaitExit }
    }),
    reapOrphans: Effect.sync(() => ledger.reap()),
  })

/**
 * PIDs of running provider servers, on disk. A PID is only killed on the next
 * launch when its command line still matches what was spawned, so a reused
 * PID never takes down an unrelated process.
 */
export class ProcessLedger {
  private readonly entries = new Map<number, string>()

  constructor(private readonly path: string | null) {}

  record(pid: number, signature: string) {
    this.entries.set(pid, signature)
    this.save()
  }

  forget(pid: number) {
    if (this.entries.delete(pid)) this.save()
  }

  /** Kills ledger entries from a previous run whose command still matches. Returns how many. */
  reap(): number {
    if (!this.path) return 0
    let previous: Record<string, string> = {}
    try {
      previous = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>
    } catch {
      return 0
    }
    let killed = 0
    for (const [pidText, signature] of Object.entries(previous)) {
      const pid = Number(pidText)
      if (!Number.isSafeInteger(pid) || pid <= 1 || this.entries.has(pid)) continue
      if (!commandMatches(pid, signature)) continue
      try {
        process.kill(-pid, 'SIGKILL')
        killed += 1
      } catch {
        // already gone
      }
    }
    this.save()
    return killed
  }

  private save() {
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.entries)))
    } catch {
      // the ledger is best effort
    }
  }
}

function commandMatches(pid: number, signature: string): boolean {
  if (process.platform === 'win32') return false
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    const [binary, sub] = signature.split(' ')
    return command.includes(binary ?? '') && (!sub || command.includes(sub))
  } catch {
    return false
  }
}

/** The supervisor over Effect's Node spawner; `ledgerPath` null disables the ledger (tests). */
export const layer = (ledgerPath: string | null) =>
  Layer.effect(
    ProcessSupervisor,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return make(spawner, new ProcessLedger(ledgerPath))
    }),
  )
