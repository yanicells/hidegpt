import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Cause from 'effect/Cause'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_TIMING, FORCE_KILL_AFTER } from '../provider/ProcessSupervisor'
import {
  type LifecycleOptions,
  makeLifecycle,
  makeSyncLog,
  SHUTDOWN_DEADLINE_MS,
  START_FAILED,
  STOPPED,
  type SyncLog,
} from './lifecycle'

interface Line {
  readonly level: string
  readonly message: unknown
  readonly annotations: Readonly<Record<string, unknown>>
}

/** A lifecycle whose runtime keeps every log line, and whose Electron calls are spies. */
function harness(overrides: Partial<LifecycleOptions> = {}) {
  const lines: Line[] = []
  const capture = Logger.make(({ fiber, logLevel, message }) => {
    lines.push({
      level: logLevel,
      message: Array.isArray(message) ? message[0] : message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    })
  })
  const spies = {
    logSync: vi.fn<SyncLog>(),
    showErrorBox: vi.fn<(title: string, content: string) => void>(),
    setExitCode: vi.fn<(code: number) => void>(),
    quit: vi.fn<() => void>(),
    exit: vi.fn<() => void>(),
    kill: vi.fn<(pid: number, signal: NodeJS.Signals) => void>(),
  }
  const options: LifecycleOptions = {
    ...spies,
    run: (effect) =>
      Effect.runPromiseExit(
        effect.pipe(
          Effect.provide(Logger.layer([capture])),
          Effect.provideService(References.MinimumLogLevel, 'Debug'),
        ),
      ).then(Exit.isSuccess),
    livePids: () => [],
    ...overrides,
  }
  return { options: spies, lines, lifecycle: makeLifecycle(options) }
}

/** Lets the log runs started so far finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('lifecycle: a program that fails', () => {
  it('logs one fatal line, shows the box once, sets exit code 1 and asks to quit', async () => {
    const { options, lines, lifecycle } = harness()
    lifecycle.programExited(Exit.die(new Error('layer bug')))
    lifecycle.programExited(Exit.die(new Error('second')))
    await settle()
    expect(lines.filter((line) => line.level === 'Fatal')).toEqual([
      { level: 'Fatal', message: 'Docs stopped', annotations: { where: 'main.program' } },
    ])
    expect(options.showErrorBox.mock.calls).toEqual([['Docs', START_FAILED]])
    expect(options.setExitCode.mock.calls).toEqual([[1]])
    expect(options.quit).toHaveBeenCalledTimes(1)
    expect(options.logSync).not.toHaveBeenCalled()
  })

  it('leaves a program that was interrupted (a normal quit) alone', async () => {
    const { options, lines, lifecycle } = harness()
    lifecycle.programExited(Exit.interrupt(1))
    lifecycle.programExited(Exit.void)
    await settle()
    expect(lines).toEqual([])
    expect(options.quit).not.toHaveBeenCalled()
  })

  it('writes the line to the file itself when the runtime cannot run it, and shows no box where none may show', async () => {
    const { options, lifecycle } = harness({ run: async () => false, showErrorBox: null })
    lifecycle.programExited(Exit.die(new Error('no runtime')))
    await settle()
    expect(options.logSync).toHaveBeenCalledWith('Fatal', 'Docs stopped', { where: 'main.program' }, expect.anything())
    expect(options.quit).toHaveBeenCalledTimes(1)
  })
})

describe('lifecycle: throws outside any fiber', () => {
  it('reports a throw once and does not rethrow it', async () => {
    const { options, lines, lifecycle } = harness()
    const process = new EventEmitter()
    lifecycle.listen(process)
    expect(() => process.emit('uncaughtException', new Error('callback bug'))).not.toThrow()
    process.emit('unhandledRejection', new Error('promise bug'))
    await settle()
    expect(lines.filter((line) => line.message === 'Unhandled defect').map((line) => line.annotations.where)).toEqual([
      'main.uncaughtException',
      'main.unhandledRejection',
    ])
    expect(options.quit).not.toHaveBeenCalled()
  })

  it('treats a fourth throw within 10 s as fatal, and three spread wider as not', async () => {
    let now = 0
    const { options, lifecycle } = harness({ now: () => now })
    const thrown = lifecycle.thrown('main.uncaughtException')
    for (const at of [0, 6_000, 12_000, 18_000]) {
      now = at
      thrown(new Error('spread out'))
    }
    await settle()
    expect(options.quit).not.toHaveBeenCalled()
    for (const at of [19_000, 20_000, 21_000]) {
      now = at
      thrown(new Error('in a loop'))
    }
    await settle()
    expect(options.showErrorBox.mock.calls).toEqual([['Docs', STOPPED]])
    expect(options.setExitCode.mock.calls).toEqual([[1]])
    expect(options.quit).toHaveBeenCalledTimes(1)
  })

  it('writes a report to the file itself when the runtime cannot', async () => {
    const { options, lifecycle } = harness({ run: async () => false })
    lifecycle.thrown('main.unhandledRejection')('rejected')
    await settle()
    expect(options.logSync).toHaveBeenCalledWith(
      'Error',
      'Unhandled defect',
      { where: 'main.unhandledRejection' },
      expect.anything(),
    )
  })
})

describe('lifecycle: quit', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('kills every listed process group and exits with one line when shutdown never finishes', async () => {
    const gone = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    const kill = vi.fn((pid: number, _signal: NodeJS.Signals) => {
      if (pid === -202) throw gone
    })
    const { options, lifecycle } = harness({ livePids: () => [101, 202, 303], kill })
    const done = vi.fn()
    lifecycle.shutDown({ stop: () => new Promise(() => {}), dispose: async () => {} }, done)
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(kill.mock.calls).toEqual([
      [-101, 'SIGKILL'],
      [-202, 'SIGKILL'],
      [-303, 'SIGKILL'],
    ])
    expect(options.logSync.mock.calls).toEqual([
      ['Fatal', 'Docs did not shut down in time; exiting without it', { pids: 3, killed: 2 }],
    ])
    expect(options.exit).toHaveBeenCalledTimes(1)
    expect(done).not.toHaveBeenCalled()
  })

  it('logs where a shutdown that finishes is, then hands over, and kills nothing', async () => {
    const { options, lines, lifecycle } = harness({ livePids: () => [101] })
    const done = vi.fn()
    const order: string[] = []
    lifecycle.shutDown(
      {
        stop: async () => void order.push('stop'),
        dispose: async () => void order.push('dispose'),
      },
      () => {
        order.push('done')
        done()
      },
    )
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS * 2)
    expect(lines.map((line) => line.message)).toEqual(['Shutdown started', 'Shutdown finished', 'Quitting'])
    expect(order).toEqual(['stop', 'dispose', 'done'])
    expect(options.kill).not.toHaveBeenCalled()
    expect(options.exit).not.toHaveBeenCalled()
  })

  it('keeps the supervisor’s waits on one release inside the deadline', () => {
    const waits = [DEFAULT_TIMING.ledgerReadCap, FORCE_KILL_AFTER, DEFAULT_TIMING.ledgerWriteCap]
    expect(waits.reduce((sum, wait) => sum + Duration.toMillis(wait), 0)).toBeLessThan(SHUTDOWN_DEADLINE_MS)
  })
})

describe('makeSyncLog', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hidegpt-synclog-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appends one line in the file logger’s shape, with the cause redacted', () => {
    const logs = join(dir, 'logs')
    const log = makeSyncLog(logs, (text) => text.replaceAll('/Users/someone', '~'))
    log('Fatal', 'Docs stopped', { killed: 2 })
    log('Error', 'Unhandled defect', { where: 'main.uncaughtException' }, Cause.die(new Error('at /Users/someone/x')))
    const [first, second] = readFileSync(join(logs, 'main.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(first).toMatchObject({ message: 'Docs stopped', level: 'FATAL', annotations: { killed: 2 } })
    expect(second.cause).toContain('at ~/x')
    expect(second.cause).not.toContain('/Users/someone')
  })
})
