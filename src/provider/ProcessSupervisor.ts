import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from 'node:child_process'

import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
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
import { forkObserved, makeRunObserved, observed } from './observed'
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
/** The waits that keep exits and quit prompt; tests that check logic rather than these caps raise them. */
export type SupervisorTiming = {
  /**
   * How long an exit waits for stderr to finish draining before it reads the
   * tail. Node emits "exit" before the pipes deliver their last data; a child
   * that keeps the pipe open must not hold the exit back.
   */
  readonly stderrDrain: Duration.Duration
  /** How long quit waits on a ledger read around a kill: 1 s before, 1 s after, plus the 2 s group stop, inside quit's 5 s. */
  readonly ledgerReadCap: Duration.Duration
}
export const DEFAULT_TIMING: SupervisorTiming = {
  stderrDrain: Duration.millis(250),
  ledgerReadCap: Duration.seconds(1),
}

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

/**
 * The tree read just before a kill, after `pending` (records still landing: an
 * entry not yet in the ledger has no tree to read). Capped, so a hung `ps`
 * cannot hold the kill back.
 */
const treeReadBeforeKill = (
  ledger: ProcessLedger.ProcessLedger['Service'],
  cap: Duration.Duration,
  pending: Effect.Effect<unknown> = Effect.void,
) => Effect.asVoid(Effect.timeoutOption(Effect.andThen(pending, ledger.track), cap))

const make = (
  spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
  ledger: ProcessLedger.ProcessLedger['Service'],
  timing: SupervisorTiming,
) =>
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
      // Released before the spawner's own kill, so this stops the server: its tree is read while
      // it still runs, its group is stopped, then whatever left the group (a `setsid` daemon).
      // The read is capped, so a slow `ps` never delays the kill past quit's deadline.
      yield* Effect.acquireRelease(ledger.record(handle.pid, options.command, options.args[0] ?? ''), () =>
        treeReadBeforeKill(ledger, timing.ledgerReadCap).pipe(
          Effect.andThen(
            Effect.exit(
              handle.kill({ forceKillAfter: FORCE_KILL_AFTER }).pipe(
                // A server that already exited cannot be signalled (as `signalGroup`): no defect.
                // One still running that could not be killed (EPERM) is.
                Effect.catchTag('PlatformError', (error) =>
                  Effect.flatMap(handle.isRunning, (running) => (running ? Effect.fail(error) : Effect.void)),
                ),
              ),
            ),
          ),
          // A kill that failed or died is reported and its record kept, so the next launch reaps the server.
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? ledger.stop(handle.pid)
              : observed(Effect.failCause(exit.cause), { name: 'supervisor.kill' }),
          ),
        ),
      )

      const tail = yield* Ref.make('')
      const draining = tailStderr
        ? yield* handle.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) => Ref.update(tail, (current) => appendStderrTail(current, chunk))),
            forkObserved({ name: 'supervisor.stderrTail' }),
          )
        : null
      // Stderr is drained before the tail is read, as T3 Code's processRunner drains output
      // before it reads the exit code; capped here, since a server's pipe may outlive it.
      const drained = draining
        ? Effect.asVoid(Effect.timeoutOption(Fiber.await(draining), timing.stderrDrain))
        : Effect.void
      const exited = (code: number | null, signal: string | null) =>
        Effect.flatMap(Effect.andThen(drained, Ref.get(tail)), (text) => {
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
      // The SDK spawns from its own callback, outside any fiber: `runObserved` keeps this layer's
      // services (its logger) and reports a defect. Made before the finalizer below, so that
      // finalizer runs first and can still wait on its fibers.
      const runObserved = yield* makeRunObserved()
      const running = new Map<
        ChildProcessWithoutNullStreams,
        { readonly pid: number; readonly recorded: Fiber.Fiber<void> }
      >()
      // Ledger stops in flight; a closing scope waits for them, so a quit leaves no record unless `ps` hangs.
      const stopping = new Set<Fiber.Fiber<void>>()
      /**
       * Stops what is left of `child`'s tree, once: whoever takes it out of `running` first
       * (its exit, or a closing scope) owns the stop. As T3 Code's `tracker.stop`.
       */
      const stopTreeOf = (child: ChildProcessWithoutNullStreams) => {
        const entry = running.get(child)
        if (!entry || !running.delete(child)) return
        // `record` is observed, so the join never fails and the stop always runs.
        const stop = runObserved(Fiber.join(entry.recorded).pipe(Effect.andThen(ledger.stop(entry.pid))), {
          name: 'supervisor.ledgerStop',
        })
        stopping.add(stop)
        stop.addObserver(() => stopping.delete(stop))
      }
      let closed = false
      // Trees are read while the CLIs still run, then each group is stopped, then what left it.
      // The reads before and after the kills are capped, so a hung `ps` keeps quit inside its deadline.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true
        }).pipe(
          // `record` is forked per spawn, so a scope that closes right after one waits for it here.
          Effect.andThen(
            Effect.suspend(() =>
              treeReadBeforeKill(
                ledger,
                timing.ledgerReadCap,
                Fiber.awaitAll([...running.values()].map(({ recorded }) => recorded)),
              ),
            ),
          ),
          Effect.andThen(
            Effect.suspend(() =>
              Effect.forEach(
                [...running],
                ([child, { pid }]) => stopGroup(child, pid).pipe(Effect.andThen(Effect.sync(() => stopTreeOf(child)))),
                { concurrency: 'unbounded', discard: true },
              ),
            ),
          ),
          Effect.andThen(
            Effect.suspend(() => Effect.timeoutOption(Fiber.awaitAll([...stopping]), timing.ledgerReadCap)),
          ),
        ),
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
        // A failed spawn or an aborted `signal` emits "error"; the caller learns of it from the
        // exit (or listens itself), and an unheard "error" would crash main.
        child.on('error', () => {})
        const pid = child.pid
        // A spawn that fails has no pid and emits only "error", which the SDK reports.
        if (pid === undefined) return child
        if (closed) {
          signalGroup(pid, 'SIGKILL')
          return child
        }
        // The full command path, so another app's copy of the same CLI never matches.
        const recorded = runObserved(ledger.record(pid, options.command, options.args[0] ?? ''), {
          name: 'supervisor.ledgerRecord',
        })
        running.set(child, { pid, recorded })
        child.once('exit', () => {
          signalGroup(pid, 'SIGKILL')
          stopTreeOf(child)
        })
        return child
      }
    }),
    reapOrphans: ledger.reap,
  })

/** The supervisor over Effect's Node spawner; `ledgerPath` null disables the ledger (tests). */
export const layer = (ledgerPath: string | null, timing: SupervisorTiming = DEFAULT_TIMING) =>
  Layer.effect(
    ProcessSupervisor,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return make(spawner, yield* ProcessLedger.ProcessLedger, timing)
    }),
  ).pipe(Layer.provide(ProcessLedger.layer(ledgerPath)))
