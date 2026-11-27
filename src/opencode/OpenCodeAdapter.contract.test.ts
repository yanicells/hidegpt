import type { ApiError, MessageOutputLengthError } from '@opencode-ai/sdk/v2/client'
import * as Effect from 'effect/Effect'

import {
  contractSuite,
  settle,
  type ContractDriver,
  type PassthroughSource,
  type Received,
} from '../provider/contract.testkit'
import { fromLegacy } from '../provider/legacyEvents'
import { agentMessage, makeFakeOpenCode, stubSession, userMessage } from './FakeOpenCode'
import * as OpenCodeAdapter from './OpenCodeAdapter'

/**
 * The adapter contract (src/provider/contract.testkit.ts) against OpenCode, over the in-process
 * server. The driver pushes the server's SSE events, holds `prompt_async` with the fake's `hold`
 * hook, and reads what the adapter sent from the fake's request log.
 */

const SESSION = 'ses_1'
/** A subagent's session: the server knows its parent, but the adapter never saw it created. */
const CHILD = 'ses_child'

/**
 * Names with a banned word. A name that passes the stealth matcher may show (owner ruling), so
 * names carry a banned word instead of the marker: the page must hide each one. Free text (an
 * error, a retry message) carries the marker, since no provider text may show.
 */
const BANNED_TOOL = 'opencode_search'
// A completed tool's name titles its callout, so only the stealth gate can hide this one.
const BANNED_DONE_TOOL = 'model_lookup'
const BANNED_PERMISSION = 'opencode-helper'

const driver: ContractDriver = {
  provider: 'opencode',
  settings: { model: 'fake/model-a', effort: null, serviceTier: null, mode: 'build' },
  open: Effect.gen(function* () {
    let hold: { reached: () => void; release: Promise<void> } | null = null
    /** How OpenCode answers the next prompt (`rejectStart`): in these words, or never (`null`). */
    let refusal: { readonly text: string | null } | null = null
    const fake = makeFakeOpenCode({
      reply: null,
      sessions: [
        stubSession(SESSION, 'Reading notes', '/tmp/course'),
        { ...stubSession(CHILD, 'Subtask', '/tmp/course'), parentID: SESSION },
      ],
      messages: {
        [SESSION]: [
          userMessage(SESSION, 'msg_000000000001u', 'Summarise week 3'),
          agentMessage(SESSION, 'msg_000000000002a', 'Week 3 covers attention.'),
        ],
      },
      hold: (method, path) => {
        if (refusal !== null && method === 'POST' && path.endsWith('/prompt_async')) {
          const { text } = refusal
          refusal = null
          if (text === null) return new Promise<never>(() => {})
          return Response.json({ name: 'BadRequestError', data: { message: text } }, { status: 400 })
        }
        const held = hold
        if (!held || method !== 'POST' || !path.endsWith('/prompt_async')) return
        hold = null
        held.reached()
        return held.release
      },
    })
    const session = yield* fromLegacy(OpenCodeAdapter.make(fake.connect)).openSession
    const opened = yield* session.openThread(SESSION)
    let answers = 0
    let asks = 0

    const stream = (text: string) =>
      Effect.sync(() => {
        answers += 1
        const messageID = `msg_00000000010${answers}a`
        const partID = `prt_00000000010${answers}a`
        const part = { id: partID, sessionID: SESSION, messageID, type: 'text' as const }
        fake.push({
          id: `evt_m${answers}`,
          type: 'message.updated',
          properties: { sessionID: SESSION, info: agentMessage(SESSION, messageID, text).info },
        })
        fake.push({
          id: `evt_p${answers}`,
          type: 'message.part.updated',
          properties: { sessionID: SESSION, part: { ...part, text: '' }, time: 1 },
        })
        for (const delta of text.match(/\S+\s*/g) ?? []) {
          fake.push({
            id: `evt_d${answers}`,
            type: 'message.part.delta',
            properties: { sessionID: SESSION, messageID, partID, field: 'text', delta },
          })
        }
        fake.push({
          id: `evt_f${answers}`,
          type: 'message.part.updated',
          properties: { sessionID: SESSION, part: { ...part, text }, time: 2 },
        })
      })
    const ask = (id: string, sessionID: string, kind = 'bash') =>
      Effect.sync(() => {
        const request = { id, sessionID, permission: kind, patterns: ['rm -r build'], metadata: {}, always: [] }
        fake.permissions.push(request)
        fake.push({ id: `evt_${id}`, type: 'permission.asked', properties: request })
        return id
      })
    /** A `session.error` as the server sends it; `error` left out means the server sent none. */
    let errors = 0
    const rawError = (sessionID: string | undefined, error?: ApiError | MessageOutputLengthError) =>
      Effect.sync(() =>
        fake.push({
          id: `evt_error_${(errors += 1)}`,
          type: 'session.error',
          properties: { ...(sessionID ? { sessionID } : {}), ...(error ? { error } : {}) },
        }),
      )
    const sessionError = (sessionID: string | undefined, message: string, statusCode: number) =>
      rawError(sessionID, { name: 'APIError', data: { message, statusCode, isRetryable: statusCode >= 500 } })
    const retrying = (message: string) =>
      Effect.sync(() => {
        const status = { type: 'retry' as const, attempt: 1, message, next: 5_000 }
        fake.status[SESSION] = status
        fake.push({ id: 'evt_retry', type: 'session.status', properties: { sessionID: SESSION, status } })
      })
    const received = (): ReadonlyArray<Received> =>
      fake.requests.flatMap((request): Received[] => {
        if (request.method !== 'POST') return []
        const [root, id, action] = request.path.split('/').filter(Boolean)
        if (root === 'session' && action === 'abort') return [{ op: 'interrupt', target: id ?? null }]
        if (root === 'permission' && action === 'reply') {
          const op = (request.body as { reply: string }).reply === 'reject' ? 'decline' : 'approve'
          return [{ op, request: id ?? '' }]
        }
        return []
      })

    const passthrough = (source: PassthroughSource, marker: string) =>
      Effect.gen(function* () {
        switch (source) {
          case 'tools':
            fake.push({
              id: 'evt_tool',
              type: 'message.part.updated',
              properties: {
                sessionID: SESSION,
                part: {
                  id: 'prt_tool',
                  sessionID: SESSION,
                  messageID: 'msg_tool',
                  type: 'tool',
                  callID: 'call_tool',
                  tool: BANNED_TOOL,
                  state: { status: 'error', input: {}, error: `${marker} tool error`, time: { start: 1, end: 2 } },
                },
                time: 1,
              },
            })
            fake.push({
              id: 'evt_tool_banned',
              type: 'message.part.updated',
              properties: {
                sessionID: SESSION,
                part: {
                  id: 'prt_banned',
                  sessionID: SESSION,
                  messageID: 'msg_tool',
                  type: 'tool',
                  callID: 'call_banned',
                  tool: BANNED_DONE_TOOL,
                  state: {
                    status: 'completed',
                    input: {},
                    output: '',
                    title: '',
                    metadata: {},
                    time: { start: 1, end: 2 },
                  },
                },
                time: 1,
              },
            })
            // A tool name that passes the stealth gate may show.
            fake.push({
              id: 'evt_tool_read',
              type: 'message.part.updated',
              properties: {
                sessionID: SESSION,
                part: {
                  id: 'prt_read',
                  sessionID: SESSION,
                  messageID: 'msg_tool',
                  type: 'tool',
                  callID: 'call_read',
                  tool: 'read',
                  state: {
                    status: 'completed',
                    input: {},
                    output: '',
                    title: '',
                    metadata: {},
                    time: { start: 1, end: 2 },
                  },
                },
                time: 1,
              },
            })
            return { hidden: [BANNED_TOOL, BANNED_DONE_TOOL], kept: ['Ran read'] }
          case 'requests':
            yield* ask('per_marker', SESSION, BANNED_PERMISSION)
            return { hidden: [BANNED_PERMISSION] }
          case 'notices':
            yield* retrying(`${marker} retrying`)
            return {}
          case 'errors':
            // Errors for no session in particular go on the banner, so each of the adapter's
            // fallbacks for an error with no message is sent too (`readableProviderError`): the
            // HTML page's <title>, the status, neither, the error's name, and no error at all.
            // Then the turn's own.
            yield* sessionError(undefined, `${marker} server error`, 500)
            yield* rawError(undefined, {
              name: 'APIError',
              data: {
                message: '<none>',
                statusCode: 503,
                isRetryable: true,
                responseBody: `<html><title>${marker} gateway</title></html>`,
              },
            })
            yield* sessionError(undefined, '<none>', 502)
            yield* rawError(undefined, { name: 'APIError', data: { message: '<none>', isRetryable: false } })
            yield* rawError(undefined, { name: 'MessageOutputLengthError', data: {} })
            yield* rawError(undefined)
            yield* settle
            yield* sessionError(SESSION, `${marker} failed`, 500)
            fake.finish(SESSION)
            // An error's type name passes the stealth gate but is the server's internals, not a sentence.
            return { hidden: ['MessageOutputLengthError'] }
          case 'crash':
            // The server writes nothing the adapter reads, so only the page's own wording can show.
            fake.exit(1)
            return {}
        }
      })

    return {
      session,
      opened,
      script: {
        answer: (text) =>
          Effect.andThen(
            stream(text),
            Effect.sync(() => fake.finish(SESSION)),
          ),
        startWaits: true,
        rejectStart: (text) =>
          Effect.sync(() => {
            refusal = { text }
            return driver.settings
          }),
        refusals: [],
        holdStart: Effect.sync(() => {
          let reached = () => {}
          let release = () => {}
          const gate = {
            reached: new Promise<void>((resolve) => (reached = resolve)),
            release: new Promise<void>((resolve) => (release = resolve)),
          }
          hold = { reached, release: gate.release }
          return { reached: Effect.promise(() => gate.reached), release: Effect.sync(release) }
        }),
        askFor: Effect.suspend(() => ask(`per_ask_${(asks += 1)}`, SESSION)),
        fail: (kind) =>
          Effect.andThen(
            kind === 'usage_limit'
              ? sessionError(SESSION, 'You exceeded your current quota, please check your plan.', 429)
              : sessionError(SESSION, 'Overloaded', 503),
            Effect.sync(() => fake.finish(SESSION)),
          ),
        // OpenCode's error carries no reset time.
        usageResetAt: null,
        exit: Effect.sync(() => fake.exit(1)),
        // A stale idle from the previous turn, landing while this turn's prompt is being accepted.
        foreignTerminal: Effect.sync(() => {
          fake.push({
            id: 'evt_stale_status',
            type: 'session.status',
            properties: { sessionID: SESSION, status: { type: 'idle' } },
          })
          fake.push({ id: 'evt_stale_idle', type: 'session.idle', properties: { sessionID: SESSION } })
        }),
        selfStart: (text) =>
          Effect.gen(function* () {
            fake.status[SESSION] = { type: 'busy' }
            fake.push({
              id: 'evt_woken',
              type: 'session.status',
              properties: { sessionID: SESSION, status: { type: 'busy' } },
            })
            yield* stream(text)
          }),
        notice: retrying,
        passthrough,
        nameDocument: (title) =>
          Effect.sync(() => {
            const info = stubSession(SESSION, title, '/tmp/course')
            fake.push({ id: 'evt_named', type: 'session.updated', properties: { sessionID: SESSION, info } })
            return null
          }),
        childRequest: ask('per_child', CHILD),
        busyChild: Effect.sync(() => {
          fake.status[CHILD] = { type: 'busy' }
          return CHILD
        }),
        nativeTurn: () => SESSION,
        received,
      },
    }
  }),
}

/** What the legacy-wrapped adapter fails today. ARCH-4c deletes each entry as it fixes it (PAR-C). */
contractSuite('OpenCode', driver, {
  exit_mid_turn: {
    why: 'A busy status still in flight when the process dies is read after the terminal and adopts a turn that never ends (PAR-C item 2, admission).',
    stream: ['on ses_1 never ended'],
  },
  respond_after_expiry: {
    why: 'A permission still open when its turn ends stays answerable, and the late reply reaches OpenCode (PAR-C item 3, O-5).',
    fails: "a reply to an expired request is refused: expected 'taken'",
  },
  foreign_terminal: {
    why: 'A stale `idle` during admission ends the new turn without checking `session.status`, before the turn has even started (PAR-C item 2).',
    fails: "a terminal that is not this turn's leaves it running",
    stream: ['ended but no turn was open'],
  },
  subagent_request: {
    why: "A request from a child session it never saw created goes to the child's id, so the page never shows it (O-4).",
    fails: 'Timed out waiting until a request is open on the page',
  },
  subagent_outlives_stop: {
    why: 'Stop aborts only the root session; a busy child keeps running (O-9).',
    fails: 'Stop reaches the busy subagent',
  },
  passthrough_errors: {
    why: 'An error for no session in particular goes on the banner as written, and so does each of `readableProviderError`\'s fallbacks when it has no message: the HTML page\'s title, the error\'s type name, and sentences that say "model provider" and "assistant". Owner: ARCH-4c / STL-1.',
    leaks: [
      'banned assistant: banner: The assistant ran into an error.',
      'banned model, provider: banner: The model provider failed the request (HTTP 502).',
      'banned model, provider: banner: The model provider failed the request and did not include an error message.',
      'banner: MessageOutputLengthError',
      'banner: ZZPROV gateway (HTTP 503).',
      'banner: ZZPROV server error',
    ],
  },
  passthrough_crash: {
    why: 'The same in-flight busy status as `exit_mid_turn` adopts a turn that never ends, and the crash banner names OpenCode (`providerLabel` in `ProcessExitedError.message`; owner ARCH-4c / STL-1).',
    stream: ['on ses_1 never ended'],
    leaks: ['banned opencode: banner: OpenCode stopped unexpectedly (exit 1). Docs is reconnecting.'],
  },
  passthrough_command: {
    why: "When the start times out, legacyEvents.send only abandons the turn; OpenCode accepts it late, the tracker adopts it under a fresh id, and it runs while the page shows the failure and has taken the message back, so a retry runs the work twice. T3 Code interrupts it (ProviderTurnStartService's interruptTurn). Owner: turn tracker / legacyEvents.send (ARCH wave 3). The timeout's sentence also names OpenCode (`providerLabel` in `ProviderTimeoutError.message`). Owner: ARCH-4c / STL-1.",
    fails: 'a turn accepted after its send failed is stopped',
    leaks: ['banned opencode: banner: OpenCode did not answer in 60 s. Try again, or use Tools → Refresh.'],
  },
  passthrough_rejected: {
    why: "OpenCode's refusal of a prompt is the banner (`errorDetail` reads `body.data.message`), and with no message its fallback names OpenCode. Owner: STL-1 / the errors cleanup.",
    leaks: ['banned opencode: banner: OpenCode did not accept that request.', 'banner: ZZPROV refused'],
  },
  title_stealth: {
    why: 'A provider title with a banned word ("Claude Code session") reaches the page and window title. Owner: STL-1 (#59).',
    fails: 'no title names a vendor or model',
  },
})
