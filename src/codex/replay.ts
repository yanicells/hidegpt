// Adapted from T3 Code (https://github.com/pingdotgg/t3code), apps/server/scripts/record-codex-app-server-replay-fixture.ts
// (layerCodex's protocol logger) at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Effect from 'effect/Effect'

import { type ReplayEntry, TurnRefusedError } from '../provider/replayFixture'
import type * as CodexClient from '../vendor/effect-codex-app-server/client.ts'

/**
 * Recording side of Codex replay (scripts/record-codex-replay.ts). Playback is
 * the vendored `replay.ts`, which takes these entries as they are.
 */

/** Every method the no-prompt recording sends. None of them reaches a model. */
export const NO_PROMPT_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'initialized',
  'account/read',
  'model/list',
  'project/list',
  'collaborationMode/list',
  'mcpServerStatus/list',
  'thread/list',
  'thread/start',
  'thread/resume',
  'thread/turns/list',
  'thread/unsubscribe',
])

/**
 * Client options that append every decoded frame to `entries`, labelled with
 * its method (a response takes its request's). Without `allowTurns`, a request
 * outside `NO_PROMPT_METHODS` dies before it is written, so it never reaches Codex.
 */
export function recordingOptions(entries: ReplayEntry[], allowTurns: boolean): CodexClient.CodexAppServerClientOptions {
  const methods = new Map<string, string>()
  return {
    logIncoming: true,
    logOutgoing: true,
    logger: (event) =>
      Effect.suspend(() => {
        if (event.stage !== 'decoded' || typeof event.payload !== 'object' || event.payload === null) return Effect.void
        const frame = event.payload as { readonly method?: unknown; readonly id?: unknown }
        const method = typeof frame.method === 'string' ? frame.method : undefined
        if (event.direction === 'outgoing' && method && !allowTurns && !NO_PROMPT_METHODS.has(method)) {
          return Effect.die(new TurnRefusedError(`send ${method}`))
        }
        const id = frame.id === undefined ? undefined : String(frame.id)
        // Requests are keyed by who sent them; a response comes from the other side.
        if (method && id) methods.set(`${event.direction}:${id}`, method)
        const asker = event.direction === 'incoming' ? 'outgoing' : 'incoming'
        const label = method ?? (id ? methods.get(`${asker}:${id}`) : undefined)
        entries.push({
          type: event.direction === 'outgoing' ? 'expect_outbound' : 'emit_inbound',
          ...(label ? { label } : {}),
          frame: event.payload,
        })
        return Effect.void
      }),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Empties every `disabledPluginIds` and sets every `planType` to "unknown" (as T3 does), at any depth. */
const withoutPluginsOrPlan = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutPluginsOrPlan)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === 'disabledPluginIds' && Array.isArray(entry)
        ? []
        : key === 'planType' && typeof entry === 'string'
          ? 'unknown'
          : withoutPluginsOrPlan(entry),
    ]),
  )
}

/**
 * A recording made with the person's own Codex home names their MCP servers
 * (with startup errors that can hold paths or URLs), the plugins they turned
 * off and their ChatGPT plan. The fixture keeps the shape and drops the
 * details, as `withoutPersonalDetails` in src/claude/replay.ts does for Claude.
 */
export function withoutPersonalDetails(entry: ReplayEntry): ReplayEntry {
  if (entry.type === 'runtime_exit') return entry
  const frame = withoutPluginsOrPlan(entry.frame)
  if (isRecord(frame) && frame.method === 'mcpServer/startupStatus/updated' && isRecord(frame.params)) {
    const { error, ...params } = frame.params
    return { ...entry, frame: { ...frame, params: { ...params, name: 'replay-mcp', ...(error === undefined ? {} : { error: error === null ? null : '<redacted>' }) } } }
  }
  return { ...entry, frame }
}
