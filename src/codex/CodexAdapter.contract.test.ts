import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Scope from 'effect/Scope'

import {
  contractSuite,
  notScripted,
  settle,
  type ContractDriver,
  type Hold,
  type Received,
} from '../provider/contract.testkit'
import { fromLegacy } from '../provider/legacyEvents'
import * as CodexAdapter from './CodexAdapter'
import { agentItem, makeFakeCodex } from './FakeCodex'

/**
 * The adapter contract (src/provider/contract.testkit.ts) against Codex, over the in-process
 * app-server peer. The driver speaks Codex's JSON-RPC: notifications for the turn, server
 * requests for approvals, and the peer's `before` hook to hold `turn/start`.
 */

const THREAD = 'thr_1'

const driver: ContractDriver = {
  provider: 'codex',
  settings: { model: null, effort: null, serviceTier: null, mode: null },
  notScripted: {
    subagent_request: 'the fake has no spawned subagent threads',
    subagent_outlives_stop: 'the fake has no spawned subagent threads',
  },
  open: Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const received: Received[] = []
    let hold: { readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> } | null = null
    let starts = 0
    /** The native turn the scripts act on: the newest `turn/start`, or one Codex started itself. */
    let native: string | null = null

    const peer = makeFakeCodex({
      reply: null,
      before: (method, params) =>
        Effect.gen(function* () {
          if (method === 'turn/interrupt') {
            received.push({ op: 'interrupt', target: (params as { turnId: string }).turnId })
          }
          if (method !== 'turn/start') return
          // The handler numbers turns in the order they arrive, as this count does.
          starts += 1
          native = `turn_${starts}`
          const held = hold
          if (!held) return
          hold = null
          yield* Deferred.succeed(held.reached, undefined)
          yield* Deferred.await(held.release)
        }),
    })
    const session = yield* fromLegacy(CodexAdapter.make(peer.connect)).openSession
    const opened = yield* session.openThread(THREAD)

    const turn = () => ({ threadId: THREAD, turnId: native ?? '' })
    const stream = (itemId: string, text: string) =>
      Effect.gen(function* () {
        for (const word of text.match(/\S+\s*/g) ?? []) {
          yield* peer.notify('item/agentMessage/delta', { ...turn(), itemId, delta: word })
        }
        yield* peer.notify('item/completed', { ...turn(), item: agentItem(itemId, text), completedAtMs: 1 })
      })
    const complete = (status: 'completed' | 'failed', error: { message: string } | null = null) =>
      peer.notify('turn/completed', {
        threadId: THREAD,
        turn: {
          id: native ?? '',
          items: [],
          status,
          ...(error ? { error: { ...error, codexErrorInfo: null, additionalDetails: null } } : {}),
        },
      })
    /** A command approval; its answer is recorded once Codex gets it. */
    const askCommand = (params: { command: string; reason?: string }) =>
      peer
        .request('item/commandExecution/requestApproval', {
          ...turn(),
          itemId: `cmd_${received.length}`,
          startedAtMs: 1,
          ...params,
        })
        .pipe(
          Effect.tap((answer) =>
            Effect.sync(() => {
              const decision = (answer as { decision?: string }).decision
              received.push({ op: decision === 'accept' ? 'approve' : 'decline' })
            }),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        )
    const turnError = (message: string, codexErrorInfo: 'internalServerError' | 'usageLimitExceeded' | null) =>
      peer.notify('error', {
        error: { message, codexErrorInfo, additionalDetails: null, misalignment: null },
        willRetry: false,
        ...turn(),
      })

    return {
      session,
      opened,
      script: {
        answer: (text) =>
          Effect.gen(function* () {
            yield* stream(`agent_${native}`, text)
            yield* complete('completed')
          }),
        holdStart: Effect.gen(function* () {
          const gate = { reached: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
          hold = gate
          return {
            reached: Deferred.await(gate.reached),
            release: Effect.asVoid(Deferred.succeed(gate.release, undefined)),
          } satisfies Hold
        }),
        askFor: askCommand({ command: 'rm -r build' }),
        fail: (kind) =>
          Effect.gen(function* () {
            if (kind === 'usage_limit') {
              const message = "You've hit your usage limit. Upgrade to Pro or try again later."
              yield* turnError(message, 'usageLimitExceeded')
              yield* complete('failed', { message })
            } else {
              const message = 'stream error: unexpected status 500 Internal Server Error'
              yield* turnError(message, 'internalServerError')
              yield* complete('failed', { message })
            }
          }),
        exit: peer.exit(1, 'thread panicked'),
        // A late terminal for an earlier turn, as after a Stop and a quick resend.
        foreignTerminal: peer.notify('turn/completed', {
          threadId: THREAD,
          turn: { id: 'turn_earlier', items: [], status: 'interrupted' },
        }),
        selfStart: (text) =>
          Effect.gen(function* () {
            native = 'turn_woken'
            yield* peer.notify('turn/started', {
              threadId: THREAD,
              turn: { id: native, items: [], status: 'inProgress' },
            })
            yield* stream(`agent_${native}`, text)
          }),
        notice: (text) =>
          peer.notify('error', {
            error: { message: text, codexErrorInfo: null, additionalDetails: null, misalignment: null },
            willRetry: true,
            ...turn(),
          }),
        passthrough: (marker) =>
          Effect.gen(function* () {
            yield* peer.notify('item/completed', {
              ...turn(),
              item: {
                type: 'mcpToolCall',
                id: 'mcp_1',
                server: `${marker}_server`,
                tool: `${marker}_search`,
                status: 'failed',
                arguments: {},
                result: null,
                error: { message: `${marker} tool error` },
                durationMs: 1,
              },
              completedAtMs: 1,
            } as never)
            yield* askCommand({ command: 'ls', reason: `${marker} reason` })
            yield* peer
              .request('mcpServer/elicitation/request', {
                ...turn(),
                serverName: `${marker}_server`,
                mode: 'form',
                message: `${marker} asks for details`,
                requestedSchema: { type: 'object', properties: {} },
                _meta: null,
              } as never)
              .pipe(Effect.forkIn(scope))
            yield* peer.notify('warning', { message: `${marker} warning` } as never)
            yield* peer.notify('error', {
              error: {
                message: `${marker} retrying`,
                codexErrorInfo: null,
                additionalDetails: null,
                misalignment: null,
              },
              willRetry: true,
              ...turn(),
            })
            // Let the requests reach the page before the turn fails and the process dies.
            yield* settle
            yield* turnError(`${marker} failed`, null)
            yield* peer.exit(1, `${marker} stderr`)
          }),
        nameDocument: (title) =>
          Effect.as(peer.notify('thread/name/updated', { threadId: THREAD, threadName: title } as never), null),
        childRequest: notScripted('subagent threads'),
        busyChild: notScripted('subagent threads'),
        nativeTurn: () => native,
        received: () => received,
      },
    }
  }),
}

/** What the legacy-wrapped adapter fails today. ARCH-4a deletes each entry as it fixes it. */
contractSuite('Codex', driver, {
  respond_after_expiry:
    "A request still open when its turn ends stays answerable, and the late reply reaches Codex. Nothing expires the turn's requests at the terminal; the adapter waits for Codex to send `serverRequest/resolved`.",
  foreign_terminal:
    'A late `turn/completed` for an earlier turn ends the open one: the legacy path drops the native turn id, so `tracker.end` cannot tell the turns apart.',
  passthrough:
    'MCP server and tool names in callout titles (`server · tool`) and in the elicitation card title; warning, retry and error text on the banner; stderr in the crash banner.',
  title_stealth:
    'A provider title with a banned word ("Claude Code session") reaches the page and window title: the runtime guard in present.ts covers tool and request titles, not document titles. Owner: STL-1 (#59).',
})
