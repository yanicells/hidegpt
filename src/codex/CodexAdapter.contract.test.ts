import { expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import {
  contractSuite,
  failureMessage,
  leakMessage,
  RESETS_AT,
  runScenario,
  type ContractDriver,
  type Hold,
  type PassthroughSource,
  type Received,
} from '../provider/contract.testkit'
import { fromLegacy } from '../provider/legacyEvents'
import type { AdapterEvent } from '../provider/ProviderAdapter'
import * as CodexAdapter from './CodexAdapter'
import { agentItem, makeFakeCodex } from './FakeCodex'

/**
 * The adapter contract (src/provider/contract.testkit.ts) against Codex, over the in-process
 * app-server peer. The driver speaks Codex's JSON-RPC: notifications for the turn, server
 * requests for approvals, and the peer's `before` hook to hold `turn/start`.
 */

const THREAD = 'thr_1'
/** A subagent's thread: Codex spawned it inside the turn, and the adapter never opened it. */
const CHILD = { threadId: 'thr_child', turnId: 'turn_child' }

const driver: ContractDriver = {
  provider: 'codex',
  settings: { model: null, effort: null, serviceTier: null, mode: null },
  open: Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const received: Received[] = []
    let hold: { readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> } | null = null
    let starts = 0
    /** The native turn the scripts act on: the newest `turn/start`, or one Codex started itself. */
    let native: string | null = null
    /** The native turn before it. */
    let previous: string | null = null

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
          previous = native
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
    let asks = 0
    /** A command approval on the open turn (or `on`); returns its item id, and records the answer once Codex gets it. */
    const askCommand = (params: { command: string; reason?: string }, on?: typeof CHILD) =>
      Effect.gen(function* () {
        asks += 1
        const itemId = `cmd_${asks}`
        yield* peer
          .request('item/commandExecution/requestApproval', { ...(on ?? turn()), itemId, startedAtMs: 1, ...params })
          .pipe(
            Effect.tap((answer) =>
              Effect.sync(() => {
                const decision = (answer as { decision?: string }).decision
                received.push({ op: decision === 'accept' ? 'approve' : 'decline', request: itemId })
              }),
            ),
            Effect.forkIn(scope),
          )
        return itemId
      })
    const turnError = (message: string, codexErrorInfo: 'internalServerError' | 'usageLimitExceeded' | null) =>
      peer.notify('error', {
        error: { message, codexErrorInfo, additionalDetails: null, misalignment: null },
        willRetry: false,
        ...turn(),
      })
    const retrying = (message: string) =>
      peer.notify('error', {
        error: { message, codexErrorInfo: null, additionalDetails: null, misalignment: null },
        willRetry: true,
        ...turn(),
      })
    const completed = (item: Record<string, unknown>) =>
      peer.notify('item/completed', { ...turn(), item, completedAtMs: 1 } as never)

    const passthrough = (source: PassthroughSource, marker: string) =>
      Effect.gen(function* () {
        switch (source) {
          case 'tools':
            yield* completed({
              type: 'mcpToolCall',
              id: 'mcp_1',
              server: `${marker}_server`,
              tool: `${marker}_search`,
              status: 'failed',
              arguments: {},
              result: null,
              error: { message: `${marker} tool error` },
              durationMs: 1,
            })
            yield* completed({
              type: 'dynamicToolCall',
              id: 'dyn_1',
              namespace: `${marker}_space`,
              tool: `${marker}_dynamic`,
              arguments: {},
              status: 'completed',
            })
            yield* completed({
              type: 'collabAgentToolCall',
              id: 'collab_1',
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: THREAD,
              receiverThreadIds: [CHILD.threadId],
              agentsStates: {},
            })
            yield* completed({
              type: 'functionCallOutput',
              id: 'fn_1',
              name: `${marker}_function`,
              namespace: `${marker}_functions`,
              output: 'ok',
            })
            // An enum, so it cannot carry the marker.
            return ['spawnAgent']
          case 'requests':
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
            return []
          case 'notices':
            yield* peer.notify('warning', { message: `${marker} warning` } as never)
            yield* peer.notify('configWarning', { summary: `${marker} config warning` })
            yield* peer.notify('guardianWarning', { threadId: THREAD, message: `${marker} guardian warning` })
            yield* retrying(`${marker} retrying`)
            return []
          case 'errors':
            yield* turnError(`${marker} failed`, null)
            yield* peer.exit(1, `${marker} stderr`)
            return []
        }
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
              // Codex reports the account's windows as it hits the limit; `resetsAt` is in seconds.
              yield* peer.notify('account/rateLimits/updated', {
                rateLimits: { primary: { usedPercent: 100, resetsAt: RESETS_AT / 1000, windowDurationMins: 300 } },
              } as never)
              const message = "You've hit your usage limit. Upgrade to Pro or try again later."
              yield* turnError(message, 'usageLimitExceeded')
              yield* complete('failed', { message })
            } else {
              const message = 'stream error: unexpected status 500 Internal Server Error'
              yield* turnError(message, 'internalServerError')
              yield* complete('failed', { message })
            }
          }),
        usageResetAt: RESETS_AT,
        exit: peer.exit(1, 'thread panicked'),
        // The stopped turn's late terminal, as after a Stop and a quick resend.
        foreignTerminal: Effect.suspend(() =>
          peer.notify('turn/completed', {
            threadId: THREAD,
            turn: { id: previous ?? '', items: [], status: 'interrupted' },
          }),
        ),
        selfStart: (text) =>
          Effect.gen(function* () {
            native = 'turn_woken'
            yield* peer.notify('turn/started', {
              threadId: THREAD,
              turn: { id: native, items: [], status: 'inProgress' },
            })
            yield* stream(`agent_${native}`, text)
          }),
        notice: retrying,
        passthrough,
        nameDocument: (title) =>
          Effect.as(peer.notify('thread/name/updated', { threadId: THREAD, threadName: title } as never), null),
        // A subagent's turn runs on its own thread; T3 Code takes its approvals and routes them by turn.
        childRequest: askCommand({ command: 'ls' }, CHILD),
        busyChild: Effect.as(
          peer.notify('turn/started', {
            threadId: CHILD.threadId,
            turn: { id: CHILD.turnId, items: [], status: 'inProgress' },
          }),
          CHILD.turnId,
        ),
        nativeTurn: () => native,
        received: () => received,
      },
    }
  }),
}

/** What the legacy-wrapped adapter fails today. ARCH-4a deletes each entry as it fixes it. */
contractSuite('Codex', driver, {
  usage_limit: {
    why: '`account/rateLimits/updated` says when the window resets (`primary.resetsAt`); the failure carries no `resetAt`.',
    fails: 'when the limit resets: expected null to be 1900000000000',
  },
  respond_after_expiry: {
    why: "A request still open when its turn ends stays answerable, and the late reply reaches Codex: nothing expires the turn's requests at the terminal.",
    fails: "a reply to an expired request is refused: expected 'taken'",
  },
  subagent_request: {
    why: 'An approval from a subagent thread the adapter never opened never reaches the page. T3 Code allows approvals from subagents (`approvalsCanOriginateFromSubagents`) and routes them by turn.',
    fails: 'Timed out waiting until a request is open on the page',
  },
  subagent_outlives_stop: {
    why: "Stop interrupts only the document's own turn; the subagent's turn on its own thread keeps running.",
    fails: 'Stop reaches the busy subagent',
  },
  passthrough_tools: {
    why: 'Dynamic and function tool names and namespaces title or fill callouts; the MCP server and tool names fill its body.',
    fails: leakMessage([
      'callout.body: ZZPROV_functions',
      'callout.body: ZZPROV_server · ZZPROV_search',
      'callout.title: ZZPROV_function',
      'callout.title: ZZPROV_space · ZZPROV_dynamic',
    ]),
  },
  passthrough_requests: {
    why: "The MCP server's name titles the elicitation card, and its message is the card's body.",
    fails: leakMessage(['approval.body: ZZPROV asks for details', 'approval.title: Continue with ZZPROV_server?']),
  },
  passthrough_notices: {
    why: 'Warning, config warning, guardian warning and retry text go on the banner.',
    fails: leakMessage([
      'banner: ZZPROV config warning',
      'banner: ZZPROV guardian warning',
      'banner: ZZPROV retrying',
      'banner: ZZPROV warning',
    ]),
  },
  passthrough_errors: {
    why: "The process's stderr goes in the crash banner.",
    fails: leakMessage(['banner: Codex stopped unexpectedly (exit 1): ZZPROV stderr. Docs is reconnecting.']),
  },
  title_stealth: {
    why: 'A provider title with a banned word ("Claude Code session") reaches the page and window title. Owner: STL-1 (#59).',
    fails: 'no title names a vendor or model',
  },
})

// The runner, not any one gap, holds every scenario to the stream contract.
it.effect('the contract runner rejects a stream that breaks the contract', () =>
  Effect.gen(function* () {
    const doubled: ContractDriver = {
      ...driver,
      open: Effect.map(driver.open, (opened) => ({
        ...opened,
        session: {
          ...opened.session,
          events: Stream.flatMap(opened.session.events, (event) =>
            Stream.fromIterable<AdapterEvent>(event.type === 'turn.ended' ? [event, event] : [event]),
          ),
        },
      })),
    }
    const exit = yield* Effect.exit(runScenario(doubled, 'simple'))
    expect(failureMessage(exit)).toContain('turn-1 ended twice')
  }),
)
