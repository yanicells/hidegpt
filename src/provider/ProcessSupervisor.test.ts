import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { afterAll, describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { ProcessSupervisor, layer } from './ProcessSupervisor'

/** Real processes: the supervisor's job is the boundary with the OS, so nothing here is faked. */
const dir = mkdtempSync(join(tmpdir(), 'hidegpt-supervisor-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const withSupervisor = <A, E>(
  use: (supervisor: ProcessSupervisor['Service']) => Effect.Effect<A, E>,
  ledgerPath: string | null = null,
) =>
  Effect.gen(function* () {
    return yield* use(yield* ProcessSupervisor)
  }).pipe(Effect.provide(layer(ledgerPath)), Effect.provide(NodeServices.layer))

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
  const until = (check: () => boolean) =>
    Effect.gen(function* () {
      for (let i = 0; i < 100 && !check(); i += 1) yield* Effect.sleep('20 millis')
      expect(check()).toBe(true)
    })

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
          { command: string; arg: string; started: string }
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
              expect(entries()[pid]).toMatchObject({ arg: '30', started: expect.stringMatching(/\d{4}$/) })
            }),
          ),
        ledgerPath,
      )
      yield* until(() => Object.keys(entries()).length === 0)
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
})
