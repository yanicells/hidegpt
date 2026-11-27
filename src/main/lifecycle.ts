// Adapted from T3 Code (apps/desktop/src/app/DesktopApp.ts, `handleFatalStartupError`, and
// apps/desktop/src/app/DesktopLifecycle.ts, `exitIfShutdownStalled`) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import type * as Exit from 'effect/Exit'

import { reportDefect } from '../provider/DefectReport'
import { MAIN_LOG } from './logging/Logger'

/**
 * How main fails closed: a program that fails says so and quits, a throw
 * outside any fiber is reported instead of crashing main behind Electron's
 * dialog, and a quit that runs out of time kills what is left by pid before it
 * exits. `app.ts` wires these to Electron and the runtime; everything here is
 * injected, so tests drive it without either.
 */

/** A shutdown that takes longer than this exits anyway, after killing every process group still listed. */
export const SHUTDOWN_DEADLINE_MS = 5_000
/** How long the fatal path waits for its log line before it shows the box and quits. */
export const FATAL_LOG_WAIT_MS = 1_000
/**
 * More uncaught exceptions than this within `THROW_WINDOW_MS` mean main is broken, so it
 * quits. Unhandled rejections are reported but not counted: an exception unwinds a callback
 * halfway and can leave main's state torn, while a rejection is a promise nobody awaited,
 * and SDKs leave benign ones behind (T3 Code's Cursor guard keeps its server running through
 * them), which must not close a document mid-session.
 */
export const THROW_LIMIT = 3
export const THROW_WINDOW_MS = 10_000

/** What the box says. Raw errors stay in the log, which Help > Report a problem opens. */
export const START_FAILED = 'Docs could not start. Try opening it again.'
export const STOPPED = 'Docs ran into a problem and has to close. Try opening it again.'

/** One line straight to the log file, for when the runtime is failing, gone or out of time. Never throws. */
export type SyncLog = (
  level: 'Fatal' | 'Error',
  message: string,
  annotations: Record<string, unknown>,
  cause?: Cause.Cause<unknown>,
) => void

/**
 * A `SyncLog` on `directory/main.ndjson`, in the file logger's shape (message,
 * level, timestamp, cause, annotations). The cause passes through `redact`,
 * as the file logger's does.
 */
export const makeSyncLog =
  (directory: string, redact: (text: string) => string): SyncLog =>
  (level, message, annotations, cause) => {
    try {
      mkdirSync(directory, { recursive: true })
      const line = {
        message,
        level: level.toUpperCase(),
        timestamp: new Date().toISOString(),
        cause: cause ? redact(Cause.pretty(cause)) : undefined,
        annotations,
        spans: {},
        fiberId: 'sync',
      }
      appendFileSync(join(directory, MAIN_LOG.name), `${JSON.stringify(line)}\n`)
    } catch {
      // Nowhere left to write: the log is the last resort.
    }
  }

export interface LifecycleOptions {
  /**
   * Runs `effect` on main's runtime and resolves true once it succeeds. A
   * failure, or a runtime that cannot run it (it failed to build, or is
   * disposed), resolves false. Never rejects.
   */
  readonly run: (effect: Effect.Effect<void>) => Promise<boolean>
  readonly logSync: SyncLog
  /** Electron's error box, or null where none may show (a screenshot run). */
  readonly showErrorBox: ((title: string, content: string) => void) | null
  readonly setExitCode: (code: number) => void
  /** `app.quit`: the quit goes through shutdown as usual. */
  readonly quit: () => void
  /** `app.exit` with the run's exit code: for a shutdown that ran out of time. */
  readonly exit: () => void
  /** The provider process groups still running (`ProcessSupervisor.livePidsSync`). */
  readonly livePids: () => ReadonlyArray<number>
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly now?: () => number
}

/** The steps of a quit's shutdown, in order. */
export interface ShutdownSteps {
  /** Interrupts the program, which closes every scope and stops the providers. */
  readonly stop: () => Promise<void>
  /** Disposes the runtime, which flushes the log. */
  readonly dispose: () => Promise<void>
}

export const makeLifecycle = (options: LifecycleOptions) => {
  const { run, logSync } = options
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal))
  const now = options.now ?? Date.now
  let fatalStarted = false
  // Set once a quit's shutdown starts, as T3 Code's `state.quitting`: a defect from a closing
  // scope is still logged, but no box holds up the quit and the exit code stays as it was.
  let quitting = false
  let throws: number[] = []

  /** True if `effect` ran within `ms`; a log line that never lands must not hold a quit. */
  const runWithin = (effect: Effect.Effect<void>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
    return Promise.race([run(effect), late]).finally(() => clearTimeout(timer))
  }

  /**
   * Logs a fatal line (straight to the file if the runtime cannot), shows the
   * box once, sets exit code 1 and quits, as T3 Code's `handleFatalStartupError`.
   * Only the first call does anything; during a quit, only the line.
   */
  const fatal = async (sentence: string, annotations: Record<string, unknown>, cause?: Cause.Cause<unknown>) => {
    if (fatalStarted) return
    fatalStarted = true
    const line = (cause ? Effect.logFatal('Docs stopped', cause) : Effect.logFatal('Docs stopped')).pipe(
      Effect.annotateLogs(annotations),
    )
    if (!(await runWithin(line, FATAL_LOG_WAIT_MS))) logSync('Fatal', 'Docs stopped', annotations, cause)
    if (quitting) return
    options.showErrorBox?.('Docs', sentence)
    options.setExitCode(1)
    options.quit()
  }

  /** Reports `cause` once under `where`, straight to the file if the runtime cannot. */
  const report = (cause: Cause.Cause<unknown>, where: string) =>
    void run(reportDefect(cause).pipe(Effect.annotateLogs({ where }), Effect.asVoid)).then((reported) => {
      if (!reported) logSync('Error', 'Unhandled defect', { where }, cause)
    })

  /**
   * The observer on the program's fiber: an exit that is not a plain interrupt is fatal.
   * After an earlier fatal (a storm of throws that already quit), the cause is still reported.
   */
  const programExited = (exit: Exit.Exit<unknown, unknown>) => {
    if (exit._tag === 'Success' || Cause.hasInterruptsOnly(exit.cause)) return
    if (fatalStarted) return report(exit.cause, 'main.program')
    void fatal(START_FAILED, { where: 'main.program' }, exit.cause)
  }

  /**
   * A throw outside any fiber: reported once, never rethrown, so Electron
   * shows no dialog. More than `THROW_LIMIT` uncaught exceptions in
   * `THROW_WINDOW_MS` are fatal; rejections are not counted (see `THROW_LIMIT`).
   */
  const thrown = (where: 'main.uncaughtException' | 'main.unhandledRejection') => (error: unknown) => {
    report(Cause.die(error), where)
    if (where !== 'main.uncaughtException') return
    const at = now()
    throws = [...throws.filter((time) => at - time < THROW_WINDOW_MS), at]
    if (throws.length > THROW_LIMIT) void fatal(STOPPED, { where, throws: throws.length })
  }

  /** Registers the two handlers on `target` (`process`). */
  const listen = (target: Pick<NodeJS.EventEmitter, 'on'>) => {
    target.on('uncaughtException', thrown('main.uncaughtException'))
    target.on('unhandledRejection', thrown('main.unhandledRejection'))
  }

  /**
   * Runs a quit's shutdown, with Debug lines that place a future stall, and
   * calls `done` once it ends. Past `SHUTDOWN_DEADLINE_MS` it stops waiting:
   * every listed process group gets SIGKILL, one Fatal line says how many,
   * and Docs exits without calling `done`.
   */
  const shutDown = (steps: ShutdownSteps, done: () => void) => {
    quitting = true
    const started = now()
    let stalled = false
    void run(Effect.logDebug('Shutdown started'))
    const deadline = setTimeout(() => {
      stalled = true
      // Each pid is a group whose leader was not seen to exit: a leader that exits leaves the
      // list, even after a failed kill (the supervisor keeps watching it), and what its group
      // left is the next launch's reap. A pid cannot be reused while its leader runs, so a wrong
      // kill needs the leader to exit and its id to go to a new group leader in the moment
      // before the exit is seen; no `ps` check is worth an async read past the deadline.
      const pids = options.livePids()
      let killed = 0
      for (const pid of pids) {
        try {
          kill(-pid, 'SIGKILL')
          killed += 1
        } catch {
          // Already gone.
        }
      }
      logSync('Fatal', 'Docs did not shut down in time; exiting without it', { pids: pids.length, killed })
      options.exit()
    }, SHUTDOWN_DEADLINE_MS)
    void (async () => {
      try {
        await steps.stop()
        await run(Effect.logDebug('Shutdown finished').pipe(Effect.annotateLogs({ ms: now() - started })))
        await run(Effect.logDebug('Quitting'))
        await steps.dispose()
      } catch (error) {
        logSync('Error', 'Shutdown failed', {}, Cause.die(error))
      } finally {
        clearTimeout(deadline)
        if (!stalled) done()
      }
    })()
  }

  return { programExited, listen, shutDown, thrown }
}
