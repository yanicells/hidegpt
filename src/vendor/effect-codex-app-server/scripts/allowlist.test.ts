import { readdirSync, readFileSync } from 'node:fs'

import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Logger from 'effect/Logger'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as References from 'effect/References'

import * as CodexRpc from '../_generated/meta.gen.ts'
import { UPSTREAM_METHODS } from '../_generated/upstream.gen.ts'
import { makeInMemoryStdio } from '../_internal/stdio.ts'
import * as CodexClient from '../client.ts'
import { PROTOCOL_ALLOWLIST } from './allowlist.ts'

const allowlisted = new Set<string>(Object.values(PROTOCOL_ALLOWLIST).flat())
const upstream = new Set(UPSTREAM_METHODS)

/** The non-test `.ts` files under `dir`, at any depth, except those `skip` matches. */
const sourcesIn = (dir: URL, skip?: RegExp) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !skip?.test(path))
    .map((path) => new URL(path, dir))

/**
 * The code that names protocol methods: src/codex and the vendored package, minus what is
 * generated from the CLI, the generator itself, and the mock peer.
 */
const sources = [
  ...sourcesIn(new URL('../../../codex/', import.meta.url)),
  ...sourcesIn(new URL('../', import.meta.url), /^(_generated|scripts|test)\//),
]

/** Methods code names without sending, handling or decoding them, so they need no schema. */
const NAMED_ONLY: Readonly<Record<string, ReadonlyArray<string>>> = {
  // The replay harness normalizes a recorded fork request like start and resume; Docs never forks.
  'vendor/effect-codex-app-server/replay.ts': ['thread/fork'],
}

/** Every string literal in `source`: quoted, or a template with no `${}`. */
const literals = (source: string) =>
  [...source.matchAll(/'([^'\n]+)'|"([^"\n]+)"|`([^`$\n]+)`/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '')

describe('protocol allowlist', () => {
  // Typed calls to a dropped method already fail typecheck; this also catches a method compared
  // by name (`frame.method === '...'`), which would silently stop matching.
  it('lists every method src/codex and the vendored package name', () => {
    const unlisted = sources.flatMap((url) => {
      const file = url.pathname.split('/src/')[1] ?? url.pathname
      const exempt = new Set(NAMED_ONLY[file])
      return literals(readFileSync(url, 'utf8'))
        .filter((text) => upstream.has(text) && !allowlisted.has(text) && !exempt.has(text))
        .map((method) => `${file}: ${method}`)
    })
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

  it.live('decodes every listed fixture notification and hands the rest to the unknown handler', () =>
    Effect.gen(function* () {
      const listed = fixtureNotifications.filter((frame) => frame.method in CodexRpc.SERVER_NOTIFICATION_PARAMS)
      const unlisted = fixtureNotifications.filter((frame) => !listed.includes(frame))
      // The fixtures hold both kinds, so neither half of this test is vacuous.
      expect(listed.length).toBeGreaterThan(0)
      expect(unlisted.length).toBeGreaterThan(0)

      // The client's decode warning names the method and the issue kinds in its annotations.
      const warnings: unknown[] = []
      const { stdio, input } = yield* makeInMemoryStdio()
      const client = yield* CodexClient.make(stdio).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, fiber }) => {
              if (logLevel === 'Warn') warnings.push(fiber.getRef(References.CurrentLogAnnotations))
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

      // A notification that fails to decode never reaches its handler. Rather than wait out
      // vitest's timeout, give up after a second and show the warning that names it.
      const take = (queue: Queue.Queue<string>, count: number) =>
        Queue.takeN(queue, count).pipe(
          Effect.timeoutOption('1 second'),
          Effect.map((taken) => {
            if (Option.isNone(taken)) expect(warnings, 'notifications that failed to decode').toEqual([])
            return Option.getOrElse(taken, () => [])
          }),
        )
      expect(yield* take(decoded, listed.length)).toEqual(listed.map((frame) => frame.method))
      expect(yield* take(unknown, unlisted.length)).toEqual(unlisted.map((frame) => frame.method))
      expect(warnings).toEqual([])
    }),
  )
})
