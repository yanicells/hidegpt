import { expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import { expectGap, failureMessage, ScenarioFailed } from '../provider/contract.checks'
import {
  contractSuite,
  RESETS_AT,
  runScenario,
  type ContractDriver,
  type KnownGaps,
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
/**
 * Names with a banned word. A name that passes the stealth matcher may show (owner ruling), so
 * names carry a banned word instead of the marker: the page must hide each one. Free text (an
 * error, a message, a brief) carries the marker, since no provider text may show.
 */
const BANNED_SERVER = 'codex_tools'
const BANNED_TOOL = 'openai-search'
const BANNED_NAMES = {
  namespace: 'codex_space',
  dynamic: 'codex_dynamic',
  function: 'codex_function',
  functions: 'gpt_functions',
  model: 'gpt-5-codex',
}

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
    /** Codex spawns the subagent as T3 Code learns of it: a `spawnAgent` item naming the child's thread. */
    const spawnChild = Effect.suspend(() =>
      peer.notify('item/started', {
        ...turn(),
        startedAtMs: 1,
        item: {
          type: 'collabAgentToolCall',
          id: 'collab_spawn',
          tool: 'spawnAgent',
          status: 'inProgress',
          senderThreadId: THREAD,
          receiverThreadIds: [CHILD.threadId],
          agentsStates: { [CHILD.threadId]: { status: 'running' } },
        },
      } as never),
    )

    const passthrough = (source: PassthroughSource, marker: string) =>
      Effect.gen(function* () {
        switch (source) {
          case 'tools':
            // Connector names may show when they pass the stealth gate (as #50 rules); one that
            // names a vendor must not. Codex runs its own connectors as `codex_apps`.
            yield* completed({
              type: 'mcpToolCall',
              id: 'mcp_1',
              server: 'files',
              tool: 'lookup',
              status: 'failed',
              arguments: {},
              result: null,
              error: { message: `${marker} tool error` },
              durationMs: 1,
            })
            yield* completed({
              type: 'mcpToolCall',
              id: 'mcp_2',
              server: BANNED_SERVER,
              tool: BANNED_TOOL,
              status: 'completed',
              arguments: {},
              result: null,
              error: null,
              durationMs: 1,
            })
            yield* completed({
              type: 'dynamicToolCall',
              id: 'dyn_1',
              namespace: BANNED_NAMES.namespace,
              tool: BANNED_NAMES.dynamic,
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
              prompt: `${marker} brief`,
              model: BANNED_NAMES.model,
              agentsStates: { [CHILD.threadId]: { status: 'completed', message: `${marker} agent message` } },
            })
            yield* completed({
              type: 'functionCallOutput',
              id: 'fn_1',
              name: BANNED_NAMES.function,
              namespace: BANNED_NAMES.functions,
              output: 'ok',
            })
            // `spawnAgent` is an enum, so it cannot carry the marker.
            return {
              hidden: ['spawnAgent', BANNED_SERVER, BANNED_TOOL, ...Object.values(BANNED_NAMES)],
              kept: ['files · lookup'],
            }
          case 'requests':
            yield* askCommand({ command: 'ls', reason: `${marker} reason` })
            for (const serverName of ['files', BANNED_SERVER]) {
              yield* peer
                .request('mcpServer/elicitation/request', {
                  ...turn(),
                  serverName,
                  mode: 'form',
                  message: serverName === 'files' ? `${marker} asks for details` : `${marker} pick a folder`,
                  requestedSchema: { type: 'object', properties: {} },
                  _meta: null,
                } as never)
                .pipe(Effect.forkIn(scope))
            }
            return { hidden: [BANNED_SERVER], kept: ['Continue with files?'] }
          case 'notices':
            yield* peer.notify('warning', { message: `${marker} warning` } as never)
            yield* peer.notify('configWarning', {
              summary: `${marker} config warning`,
              details: `${marker} config details`,
            })
            yield* peer.notify('guardianWarning', { threadId: THREAD, message: `${marker} guardian warning` })
            yield* retrying(`${marker} retrying`)
            return {}
          case 'errors':
            yield* turnError(`${marker} failed`, null)
            yield* complete('failed', { message: `${marker} turn failed` })
            return {}
          case 'crash':
            yield* peer.exit(1, `${marker} stderr`)
            return {}
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
        childRequest: Effect.andThen(spawnChild, askCommand({ command: 'ls' }, CHILD)),
        busyChild: spawnChild.pipe(
          Effect.andThen(
            peer.notify('turn/started', {
              threadId: CHILD.threadId,
              turn: { id: CHILD.turnId, items: [], status: 'inProgress' },
            }),
          ),
          Effect.as(CHILD.turnId),
        ),
        nativeTurn: () => native,
        received: () => received,
      },
    }
  }),
}

/** What the legacy-wrapped adapter fails today. ARCH-4a deletes each entry as it fixes it. */
const GAPS = {
  usage_limit: {
    why: '`account/rateLimits/updated` says when the window resets (`primary.resetsAt`); the failure carries no `resetAt`.',
    fails: 'when the limit resets: expected null to be 1900000000000',
  },
  respond_after_expiry: {
    why: 'A request still open when its turn ends shows as skipped, but the adapter keeps it answerable, so a late reply still reaches Codex.',
    fails: "a reply to an expired request is refused: expected 'taken'",
  },
  subagent_request: {
    why: 'An approval from a subagent never reaches the page: the adapter ignores the `spawnAgent` item that names its thread (`receiverThreadIds`). T3 Code registers the child from it, allows approvals from subagents (`approvalsCanOriginateFromSubagents`) and routes them by turn.',
    fails: 'Timed out waiting until a request is open on the page',
  },
  subagent_outlives_stop: {
    why: "Stop interrupts only the document's own turn; the subagent's turn on the thread `spawnAgent` named keeps running.",
    fails: 'Stop reaches the busy subagent',
  },
  passthrough_tools: {
    why: "A function call's namespace fills its callout body unchecked, so a banned one shows, and a subagent's brief fills the spawn callout. Connector, dynamic and function tool names are gated.",
    leaks: ['banned gpt: callout.body: gpt_functions', 'callout.body: ZZPROV brief'],
  },
  passthrough_requests: {
    why: "Each connector's elicitation message is the card's body. Its name in the title is gated: a stealthy one stays, a banned one is dropped.",
    leaks: ['approval.body: ZZPROV asks for details', 'approval.body: ZZPROV pick a folder'],
  },
  passthrough_notices: {
    why: 'Warning, config warning, guardian warning and retry text go on the banner.',
    leaks: [
      'banner: ZZPROV config warning',
      'banner: ZZPROV guardian warning',
      'banner: ZZPROV retrying',
      'banner: ZZPROV warning',
    ],
  },
  passthrough_crash: {
    why: "The process's stderr goes in the crash banner, and the banner names Codex (`providerLabel` in `ProcessExitedError.message`). Owner: ARCH-4a / STL-1.",
    leaks: ['banned codex: banner: Codex stopped unexpectedly (exit 1): ZZPROV stderr. Docs is reconnecting.'],
  },
  title_stealth: {
    why: 'A provider title with a banned word ("Claude Code session") reaches the page and window title. Owner: STL-1 (#59).',
    fails: 'no title names a vendor or model',
  },
} satisfies KnownGaps

contractSuite('Codex', driver, GAPS)

/** The driver, with every `turn.ended` sent twice: a stream that breaks the contract. */
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

// The runner, not any one gap, holds every scenario to the stream contract.
it.effect('the contract runner rejects a stream that breaks the contract', () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(runScenario(doubled, 'simple'))
    expect(failureMessage(exit)).toContain('turn-1 ended twice')
  }),
)

// A gap that lists a scenario's leaks still fails when the stream also breaks the contract.
it.effect('a known leak never hides a broken stream', () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(runScenario(doubled, 'passthrough_tools'))
    expect(failureMessage(exit)).toContain('ended twice')
    const guarded = yield* Effect.exit(expectGap(GAPS.passthrough_tools)(exit))
    expect(Exit.isFailure(guarded), 'the gap rejects the broken stream').toBe(true)
  }),
)

/** The driver, with a kept name that never shows: every `passthrough` body fails its own check. */
const unkept: ContractDriver = {
  ...driver,
  open: Effect.map(driver.open, (opened) => ({
    ...opened,
    script: {
      ...opened.script,
      passthrough: (source, marker) =>
        Effect.map(opened.script.passthrough(source, marker), (passed) => ({
          ...passed,
          kept: [...(passed.kept ?? []), 'never shown'],
        })),
    },
  })),
}

// The runner reads the leaks off the page, so a body that failed still reports them, and a gap
// that lists only how the body fails rejects the run.
it.effect('a failed scenario still reports what the page leaked', () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(runScenario(unkept, 'passthrough_tools'))
    const verdict = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null
    expect(verdict).toBeInstanceOf(ScenarioFailed)
    const { broke, leaks } = (verdict as ScenarioFailed).verdict
    expect(broke).toContain('stays on the callout: never shown')
    expect(leaks).toEqual(GAPS.passthrough_tools.leaks)
    const failsOnly = { why: 'only the failed check', fails: 'never shown' }
    const guarded = yield* Effect.exit(expectGap(failsOnly)(exit))
    expect(Exit.isFailure(guarded), 'a gap that lists no leaks rejects them').toBe(true)
  }),
)
