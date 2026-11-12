import * as Effect from 'effect/Effect'

import { contractSuite, settle, type ContractDriver, type Received } from '../provider/contract.testkit'
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

const driver: ContractDriver = {
  provider: 'opencode',
  settings: { model: 'fake/model-a', effort: null, serviceTier: null, mode: 'build' },
  open: Effect.gen(function* () {
    let hold: { reached: () => void; release: Promise<void> } | null = null
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
      })
    const sessionError = (sessionID: string | undefined, message: string, statusCode: number) =>
      Effect.sync(() =>
        fake.push({
          id: 'evt_error',
          type: 'session.error',
          properties: {
            ...(sessionID ? { sessionID } : {}),
            error: { name: 'APIError', data: { message, statusCode, isRetryable: statusCode >= 500 } },
          },
        }),
      )
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
          return [{ op: (request.body as { reply: string }).reply === 'reject' ? 'decline' : 'approve' }]
        }
        return []
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
        askFor: ask('per_ask', SESSION),
        fail: (kind) =>
          Effect.andThen(
            kind === 'usage_limit'
              ? sessionError(SESSION, 'You exceeded your current quota, please check your plan.', 429)
              : sessionError(SESSION, 'Overloaded', 503),
            Effect.sync(() => fake.finish(SESSION)),
          ),
        exit: Effect.sync(() => fake.exit(1)),
        // A stale idle: the server is still busy with this turn (a late event from the previous one).
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
        passthrough: (marker) =>
          Effect.gen(function* () {
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
                  tool: `${marker}_search`,
                  state: { status: 'error', input: {}, error: `${marker} tool error`, time: { start: 1, end: 2 } },
                },
                time: 1,
              },
            })
            yield* ask('per_marker', SESSION, marker)
            yield* retrying(`${marker} retrying`)
            yield* sessionError(undefined, `${marker} server error`, 500)
            yield* settle
            yield* sessionError(SESSION, `${marker} failed`, 500)
            fake.finish(SESSION)
            yield* settle
            fake.exit(1)
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
  exit_mid_turn:
    'A busy status still in flight when the process dies is read after the terminal and adopts a turn that never ends (PAR-C item 2, admission).',
  respond_after_expiry:
    'A permission still open when its turn ends stays answerable, and the late reply reaches OpenCode (PAR-C item 3, O-5).',
  foreign_terminal: 'A stale `idle` ends the running turn without checking `session.status` (PAR-C item 2).',
  subagent_request:
    "A request from a child session it never saw created goes to the child's id, so the page never shows it (O-4).",
  subagent_outlives_stop: 'Stop aborts only the root session; a busy child keeps running (O-9).',
  passthrough:
    'The raw tool name in callout titles (`Ran <tool>`), the permission name in the card title, and a sessionless error message on the banner.',
})
