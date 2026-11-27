import { readdirSync, readFileSync } from 'node:fs'

import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Logger from 'effect/Logger'
import * as Queue from 'effect/Queue'

import * as CodexRpc from '../_generated/meta.gen.ts'
import { UPSTREAM_METHODS } from '../_generated/upstream.gen.ts'
import { makeInMemoryStdio } from '../_internal/stdio.ts'
import * as CodexClient from '../client.ts'
import { PROTOCOL_ALLOWLIST } from './allowlist.ts'

const allowlisted = new Set<string>(Object.values(PROTOCOL_ALLOWLIST).flat())
const upstream = new Set(UPSTREAM_METHODS)

/** The code that names protocol methods: src/codex and the vendored client's runtime. */
const sources = [
  ...readdirSync(new URL('../../../codex/', import.meta.url))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => new URL(`../../../codex/${name}`, import.meta.url)),
  ...['client.ts', 'protocol.ts', '_internal/shared.ts', '_internal/stdio.ts'].map(
    (name) => new URL(`../${name}`, import.meta.url),
  ),
]

describe('protocol allowlist', () => {
  // Typed calls to a dropped method already fail typecheck; this also catches a method compared
  // by name (`frame.method === '...'`), which would silently stop matching.
  it('lists every method src/codex and the client name', () => {
    const unlisted = sources.flatMap((url) =>
      [...readFileSync(url, 'utf8').matchAll(/'([^'\n]+)'|"([^"\n]+)"/g)]
        .map((match) => match[1] ?? match[2] ?? '')
        .filter((text) => upstream.has(text) && !allowlisted.has(text))
        .map((method) => `${url.pathname.split('/src/')[1]}: ${method}`),
    )
    expect(unlisted, 'add these to scripts/allowlist.ts and run `pnpm protocol`').toEqual([])
  })

  it('matches the generated methods, so a list edit without `pnpm protocol` fails', () => {
    const generated = (methods: object) => Object.keys(methods).toSorted()
    expect({
      clientRequests: generated(CodexRpc.CLIENT_REQUEST_METHODS),
      clientNotifications: generated(CodexRpc.CLIENT_NOTIFICATION_METHODS),
      serverRequests: generated(CodexRpc.SERVER_REQUEST_METHODS),
      serverNotifications: generated(CodexRpc.SERVER_NOTIFICATION_METHODS),
    }).toEqual({
      clientRequests: PROTOCOL_ALLOWLIST.clientRequests.toSorted(),
      clientNotifications: PROTOCOL_ALLOWLIST.clientNotifications.toSorted(),
      serverRequests: PROTOCOL_ALLOWLIST.serverRequests.toSorted(),
      serverNotifications: PROTOCOL_ALLOWLIST.serverNotifications.toSorted(),
    })
  })

  /** Every notification Codex sent in the recorded replay fixtures. */
  const fixtureNotifications = readdirSync(new URL('../../../codex/fixtures/', import.meta.url))
    .filter((name) => name.endsWith('.ndjson'))
    .flatMap((name) =>
      readFileSync(new URL(`../../../codex/fixtures/${name}`, import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { type: string; frame?: { id?: unknown; method?: unknown } })
        .flatMap((entry) =>
          entry.type === 'emit_inbound' && entry.frame?.id === undefined && typeof entry.frame?.method === 'string'
            ? [entry.frame as { method: string; params?: unknown }]
            : [],
        ),
    )

  it.effect('decodes every listed fixture notification and hands the rest to the unknown handler', () =>
    Effect.gen(function* () {
      const listed = fixtureNotifications.filter((frame) => frame.method in CodexRpc.SERVER_NOTIFICATION_PARAMS)
      const unlisted = fixtureNotifications.filter((frame) => !listed.includes(frame))
      // The fixtures hold both kinds, so neither half of this test is vacuous.
      expect(listed.length).toBeGreaterThan(0)
      expect(unlisted.length).toBeGreaterThan(0)

      const warnings: unknown[] = []
      const { stdio, input } = yield* makeInMemoryStdio()
      const client = yield* CodexClient.make(stdio).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, message }) => {
              if (logLevel === 'Warn') warnings.push(message)
            }),
          ]),
        ),
      )
      const decoded = yield* Queue.unbounded<string>()
      const unknown = yield* Queue.unbounded<string>()
      for (const method of new Set(listed.map((frame) => frame.method))) {
        yield* client.handleServerNotification(method as CodexRpc.ServerNotificationMethod, () =>
          Queue.offer(decoded, method).pipe(Effect.asVoid),
        )
      }
      yield* client.handleUnknownServerNotification((method) => Queue.offer(unknown, method).pipe(Effect.asVoid))

      for (const frame of fixtureNotifications) {
        yield* Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(frame)}\n`))
      }

      // A notification that failed to decode never reaches its handler, so these would time out.
      expect(yield* Queue.takeN(decoded, listed.length)).toEqual(listed.map((frame) => frame.method))
      expect(yield* Queue.takeN(unknown, unlisted.length)).toEqual(unlisted.map((frame) => frame.method))
      expect(warnings).toEqual([])
    }).pipe(Effect.timeout('5 seconds')),
  )
})
