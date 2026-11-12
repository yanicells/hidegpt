import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { afterAll, describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as TestConsole from 'effect/testing/TestConsole'

import * as Logging from './Logger'
import { makeRotatingFileSink } from './rotatingFileSink'

const root = mkdtempSync(join(tmpdir(), 'docs-logs-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const tempDir = () => mkdtempSync(join(root, 'case-'))

describe('makeRotatingFileSink', () => {
  it.effect('rotates by size and keeps at most maxFiles backups', () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const filePath = join(dir, 'main.ndjson')
      const sink = yield* makeRotatingFileSink({ filePath, maxBytes: 10, maxFiles: 2 })
      for (const line of ['aaaaaa\n', 'bbbbbb\n', 'cccccc\n', 'dddddd\n']) yield* sink.write(line)

      expect(readdirSync(dir).sort()).toEqual(['main.ndjson', 'main.ndjson.1', 'main.ndjson.2'])
      expect(readFileSync(filePath, 'utf8')).toBe('dddddd\n')
      expect(readFileSync(`${filePath}.1`, 'utf8')).toBe('cccccc\n')
      expect(readFileSync(`${filePath}.2`, 'utf8')).toBe('bbbbbb\n')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('makes the folder again when it is deleted while Docs runs', () =>
    Effect.gen(function* () {
      const dir = join(tempDir(), 'logs')
      const filePath = join(dir, 'main.ndjson')
      const sink = yield* makeRotatingFileSink({ filePath, maxBytes: 100, maxFiles: 2 })
      yield* sink.write('before\n')
      rmSync(dir, { recursive: true })
      yield* sink.write('after\n')
      expect(readFileSync(filePath, 'utf8')).toBe('after\n')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('drops backups beyond the limit when it opens', () =>
    Effect.gen(function* () {
      const dir = tempDir()
      for (const name of ['main.ndjson', 'main.ndjson.1', 'main.ndjson.4', 'other.ndjson.9'])
        writeFileSync(join(dir, name), 'x\n')
      yield* makeRotatingFileSink({ filePath: join(dir, 'main.ndjson'), maxBytes: 100, maxFiles: 2 })
      expect(readdirSync(dir).sort()).toEqual(['main.ndjson', 'main.ndjson.1', 'other.ndjson.9'])
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})

describe('Logger.layer', () => {
  it.effect('writes each log as one JSON line in main.ndjson, flushed when the runtime closes', () =>
    Effect.gen(function* () {
      const dir = tempDir()
      yield* Effect.logWarning('Connection lost').pipe(
        Effect.annotateLogs({ provider: 'codex' }),
        Effect.andThen(Effect.logDebug('Connected')),
        Effect.provide(Logging.layer({ directory: dir, console: false }).pipe(Layer.provide(NodeServices.layer))),
      )
      const lines = readFileSync(join(dir, 'main.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(lines).toMatchObject([
        { level: 'WARN', message: 'Connection lost', annotations: { provider: 'codex' } },
        { level: 'DEBUG', message: 'Connected' },
      ])
    }),
  )

  it.effect('without a log folder, prints each line to the terminal once', () =>
    Effect.gen(function* () {
      // A folder inside a file cannot be made.
      const file = join(tempDir(), 'not-a-folder')
      writeFileSync(file, '')
      yield* Effect.logWarning('Connection lost').pipe(
        Effect.provide(
          Logging.layer({ directory: join(file, 'logs'), console: true }).pipe(Layer.provide(NodeServices.layer)),
        ),
      )
      const printed = [...(yield* TestConsole.logLines), ...(yield* TestConsole.errorLines)].map(String)
      expect(printed.filter((line) => line.includes('Connection lost'))).toHaveLength(1)
    }),
  )

  it.effect('writes causes without the home folder, the account name, or credentials', () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const identity = { home: '/Users/alice-k', username: 'alice-k' }
      const error = new Error(
        "ENOENT: open '/Users/alice-k/Library/Application Support/Docs/x.png' as alice-k, " +
          'GET https://api.example/v1?access_token=tok-9f2e&page=2 Authorization: Bearer abc.def-123 key sk-proj-0123456789abcdefghij',
      )
      yield* Effect.logError('Unhandled defect', Cause.die(error)).pipe(
        Effect.provide(
          Logging.layer({ directory: dir, console: false, identity }).pipe(Layer.provide(NodeServices.layer)),
        ),
      )
      const log = readFileSync(join(dir, 'main.ndjson'), 'utf8')
      expect(JSON.parse(log).cause).toMatch(/^Error: ENOENT: open/)
      expect(log).toContain("open '~/Library/Application Support/Docs/x.png' as <user>")
      expect(log).toContain('access_token=<redacted>&page=2')
      expect(log).toContain('Bearer <redacted>')
      for (const secret of ['alice-k', 'tok-9f2e', 'abc.def-123', 'sk-proj-0123456789abcdefghij'])
        expect(log).not.toContain(secret)
    }),
  )

  it.effect('writes a long defect cut to 2 KB, without the email or the home folder', () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const identity = { home: '/Users/alice-k', username: 'alice-k' }
      const error = new Error(
        `request for alice.k@example.com from /Users/alice-k/Documents failed: ${'x'.repeat(10 * 1024)} END`,
      )
      yield* Effect.logError('Unhandled defect', Cause.die(error)).pipe(
        Effect.provide(
          Logging.layer({ directory: dir, console: false, identity }).pipe(Layer.provide(NodeServices.layer)),
        ),
      )
      const log = readFileSync(join(dir, 'main.ndjson'), 'utf8')
      expect(Buffer.byteLength(log)).toBeLessThan(3 * 1024)
      expect(JSON.parse(log).cause).toMatch(/^Error: request for <email> from ~\/Documents failed: x+\n… \(cut\)$/)
      for (const secret of ['alice.k@example.com', '/Users/alice-k', 'END']) expect(log).not.toContain(secret)
    }),
  )
})
