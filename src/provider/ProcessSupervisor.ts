import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { basename } from 'node:path'

import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import * as Ref from 'effect/Ref'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import type { ProviderId } from '../shared/model'
import { appendStderrTail, stderrExcerpt } from '../vendor/effect-codex-app-server/_internal/stdio'
import { BinaryMissingError, ProcessExitedError, ProviderRequestError } from './errors'
import { providerLabel } from '../shared/labels'
import * as ProcessLedger from './ProcessLedger'

/**
 * Starts provider processes. Effect's Node spawner already gives each child
 * its own process group and, when the owning `Scope` closes, sends SIGTERM to
 * the whole group and SIGKILL after `forceKillAfter`. This service adds what
 * HideGPT needs on top: a `BinaryMissingError` for a missing CLI, a typed
 * `ProcessExitedError`, an 8 KiB stderr tail, and an orphan ledger so a
 * hard-killed Electron main (no finalizers ran) does not leave servers behind:
 * the next launch reaps them. (T3 Code gets the same guarantee by having its
 * server watch its launcher; HideGPT's main *is* the launcher.)
 *
 * SDKs that start their own CLI through a callback (Claude Code) use
 * `callbackSpawner`, which gives the same guarantees synchronously.
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

/** What an SDK hands its spawn callback (Claude Code's `SpawnOptions`), plus where stderr goes. */
export type CallbackSpawnOptions = {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  /** Passed to the child exactly as given: never merged, read or logged. */
  readonly env: Record<string, string | undefined>
  readonly signal?: AbortSignal | undefined
  readonly onStderr?: (text: string) => void
}

export type CallbackSpawn = (options: CallbackSpawnOptions) => ChildProcessWithoutNullStreams

export class ProcessSupervisor extends Context.Service<
  ProcessSupervisor,
  {
    /** Spawns in the caller's scope; closing the scope kills the process group. */
    readonly spawn: (
      options: SpawnOptions,
      tailStderr?: boolean,
    ) => Effect.Effect<SupervisedProcess, BinaryMissingError | ProviderRequestError, Scope.Scope>
    /**
     * A synchronous spawn for SDK callbacks. Each child leads its own process group, is in
     * the ledger while it runs, has its stderr drained, and its group is killed when it
     * exits (taking its own children, such as MCP servers, along) or when the caller's
     * scope closes (SIGTERM, then SIGKILL after `FORCE_KILL_AFTER`).
     */
    readonly callbackSpawner: Effect.Effect<CallbackSpawn, never, Scope.Scope>
    /** Kills servers a previous, crashed run left behind. */
    readonly reapOrphans: Effect.Effect<number>
  }
>()('hidegpt/ProcessSupervisor') {}

const signalFrom = (error: PlatformError.PlatformError): string | null =>
  /signal: '([A-Z0-9]+)'/.exec(error.message)?.[1] ?? null

const isNotFound = (error: PlatformError.PlatformError) =>
  error.reason._tag === 'NotFound' || /ENOENT/.test(error.message)

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal)
  } catch {
    // already gone
  }
}

const hasExited = (child: ChildProcessWithoutNullStreams) => child.exitCode !== null || child.signalCode !== null

/** SIGTERM to the group, then SIGKILL if the leader has not exited in time. */
const stopGroup = (child: ChildProcessWithoutNullStreams, pid: number) =>
  Effect.callback<void>((resume) => {
    if (hasExited(child)) return resume(Effect.void)
    const done = () => resume(Effect.void)
    child.once('exit', done)
    signalGroup(pid, 'SIGTERM')
    return Effect.sync(() => child.off('exit', done))
  }).pipe(
    Effect.timeoutOrElse({ duration: FORCE_KILL_AFTER, orElse: () => Effect.sync(() => signalGroup(pid, 'SIGKILL')) }),
  )

const make = (spawner: ChildProcessSpawner.ChildProcessSpawner['Service'], ledger: ProcessLedger.ProcessLedger['Service']) =>
  ProcessSupervisor.of({
    spawn: Effect.fn('ProcessSupervisor.spawn')(function* (options, tailStderr = false) {
      const command = ChildProcess.make(options.command, [...options.args], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env, extendEnv: true } : {}),
        forceKillAfter: FORCE_KILL_AFTER,
      })
      const handle = yield* spawner.spawn(command).pipe(
        // Only a missing command means "not installed"; anything else (no permission, a bad cwd) says what failed.
        Effect.mapError((error) =>
          isNotFound(error)
            ? new BinaryMissingError({ provider: options.provider, command: options.command })
            : new ProviderRequestError({
                provider: options.provider,
                operation: 'spawn',
                detail: `Docs could not start ${providerLabel(options.provider)}: ${error.message}`,
              }),
        ),
      )
      yield* Effect.acquireRelease(ledger.record(handle.pid, basename(options.command), options.args[0] ?? ''), () =>
        ledger.forget(handle.pid),
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
    /**
     * Adapted from T3 Code (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts,
     * `spawnClaudeProcessGroup`) at commit 5c6f2f12.
     * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
     */
    callbackSpawner: Effect.gen(function* () {
      const running = new Map<ChildProcessWithoutNullStreams, number>()
      let closed = false
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          closed = true
          return Effect.forEach(running, ([child, pid]) => stopGroup(child, pid), { concurrency: 'unbounded', discard: true })
        }),
      )
      return (options: CallbackSpawnOptions) => {
        const child = spawnChild(options.command, [...options.args], {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        })
        // Always drained, so a chatty CLI never blocks on a full stderr pipe.
        child.stderr.setEncoding('utf8').on('data', (text: string) => options.onStderr?.(text))
        const pid = child.pid
        // A spawn that fails has no pid and emits only "error", which the SDK reports.
        if (pid === undefined) return child
        if (closed) {
          signalGroup(pid, 'SIGKILL')
          return child
        }
        running.set(child, pid)
        const recorded = Effect.runFork(ledger.record(pid, basename(options.command), options.args[0] ?? ''))
        child.once('exit', () => {
          running.delete(child)
          signalGroup(pid, 'SIGKILL')
          Effect.runFork(Fiber.join(recorded).pipe(Effect.andThen(ledger.forget(pid))))
        })
        return child
      }
    }),
    reapOrphans: ledger.reap,
  })

/** The supervisor over Effect's Node spawner; `ledgerPath` null disables the ledger (tests). */
export const layer = (ledgerPath: string | null) =>
  Layer.effect(
    ProcessSupervisor,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return make(spawner, yield* ProcessLedger.ProcessLedger)
    }),
  ).pipe(Layer.provide(ProcessLedger.layer(ledgerPath)))
