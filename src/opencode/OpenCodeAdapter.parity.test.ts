import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'

import type {
  LegacyAdapterEvent as AdapterEvent,
  LegacyProviderSession as ProviderSession,
} from '../provider/legacyEvents'
import { agentMessage, makeFakeOpenCode, stubSession, userMessage, type FakeOpenCodeOptions } from './FakeOpenCode'
import * as OpenCodeAdapter from './OpenCodeAdapter'

/**
 * Protocol cases T3 Code's OpenCode adapter handles (packages/provider-opencode/src/server/adapter.ts
 * at 5c6f2f12) that this adapter did not. Each test states the behaviour Docs needs; the skipped
 * ones name the package that builds them (research/reports/fable-provider-parity.md, section 3).
 */

const SETTINGS = { model: 'fake/model-a', effort: null, serviceTier: null, mode: 'build' }
const SESSION = 'ses_1'
const CHILD = 'ses_child'
const HISTORY = {
  sessions: [stubSession(SESSION, 'Reading notes', '/tmp/course')],
  messages: {
    [SESSION]: [
      userMessage(SESSION, 'msg_000000000001u', 'Summarise week 3'),
      agentMessage(SESSION, 'msg_000000000002a', 'Week 3 covers attention.'),
    ],
  },
}
/** A subagent's session: the server knows its parent, but Docs never saw it created. */
const WITH_CHILD = {
  sessions: [...HISTORY.sessions, { ...stubSession(CHILD, 'Subtask', '/tmp/course'), parentID: SESSION }],
}

const tick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
const settle = Effect.repeat(tick, { times: 20 })
const until = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !check(); i += 1) yield* tick
    expect(check()).toBe(true)
  })

const open = (options: FakeOpenCodeOptions = {}) =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode({ ...HISTORY, reply: null, ...options })
    const session = yield* OpenCodeAdapter.make(fake.connect).openSession
    const events: AdapterEvent[] = []
    yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(Effect.forkScoped)
    return { fake, session, events }
  })

const send = (session: ProviderSession, text: string) =>
  session.send(SESSION, { text, images: [], skill: null, clientId: session.messageId() }, SETTINGS)

const ended = (events: ReadonlyArray<AdapterEvent>) => events.filter((event) => event.type === 'turnEnded')
const approvals = (events: ReadonlyArray<AdapterEvent>) =>
  events.flatMap((event) => (event.type === 'block' && event.block.kind === 'approval' ? [event] : []))
const callouts = (events: ReadonlyArray<AdapterEvent>) =>
  events.flatMap((event) => (event.type === 'block' && event.block.kind === 'callout' ? [event.block] : []))

const permission = (id: string, sessionID = SESSION) => ({
  id,
  sessionID,
  permission: 'bash',
  patterns: ['git status'],
  metadata: {},
  always: [],
})

const toolPart = (id: string, tool: string, state: Record<string, unknown>) =>
  ({ id, sessionID: SESSION, messageID: 'msg_tool', type: 'tool', callID: `call_${id}`, tool, state }) as never

describe('OpenCodeAdapter parity with T3 Code', () => {
  // Owned by PAR-C item 1 (ARCH-4c).
  it.effect.skip('ends a turn exactly once', () =>
    Effect.gen(function* () {
      const { session, events } = yield* open({ reply: () => 'Done.' })
      yield* session.openThread(SESSION)
      yield* send(session, 'Why?')
      yield* until(() => ended(events).length > 0)
      yield* settle
      // The server sends `session.status idle` and `session.idle`; T3 finalizes once (adapter.ts:2045 `turn.finalized`).
      expect(ended(events)).toHaveLength(1)
    }),
  )

  // Owned by PAR-C item 1 (ARCH-4c).
  it.effect.skip('ends a stopped turn exactly once', () =>
    Effect.gen(function* () {
      const { session, events } = yield* open()
      yield* session.openThread(SESSION)
      yield* send(session, 'Long answer')
      yield* until(() => events.some((event) => event.type === 'turnStarted'))
      yield* session.interrupt(SESSION)
      yield* until(() => ended(events).length > 0)
      yield* settle
      expect(ended(events)).toHaveLength(1)
    }),
  )

  // Owned by PAR-E3.
  it.effect.skip("restores a subagent's approval that was waiting when the document opens", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* open(WITH_CHILD)
      fake.permissions.push(permission('per_child', CHILD))
      const opened = yield* session.openThread(SESSION)
      // T3 walks `session.get` up to the owning thread (adapter.ts:1979-2000 resolveSessionOwner).
      expect(opened.blocks.filter((block) => block.kind === 'approval')).toMatchObject([{ id: 'approval-per_child' }])
    }),
  )

  // Owned by PAR-E3.
  it.effect.skip('routes an approval from a subagent session Docs never saw created', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open(WITH_CHILD)
      yield* session.openThread(SESSION)
      fake.permissions.push(permission('per_live', CHILD))
      fake.push({ id: 'evt_p', type: 'permission.asked', properties: permission('per_live', CHILD) })
      yield* until(() => approvals(events).length === 1)
      // Under the child's id the manager drops it (no runtime), and the turn waits forever.
      expect(approvals(events)[0]).toMatchObject({ threadId: SESSION })
    }),
  )

  // Owned by PAR-C item 3 (ARCH-4c).
  it.effect.skip('leaves no approval open once the turn has ended', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* session.openThread(SESSION)
      yield* send(session, 'Run it')
      fake.permissions.push(permission('per_open'))
      fake.push({ id: 'evt_p', type: 'permission.asked', properties: permission('per_open') })
      yield* until(() => approvals(events).length === 1)
      fake.push({
        id: 'evt_e',
        type: 'session.error',
        properties: {
          sessionID: SESSION,
          error: { name: 'APIError', data: { message: 'Overloaded', isRetryable: false } },
        },
      })
      fake.finish(SESSION)
      yield* until(() => ended(events).length > 0)
      yield* settle
      // T3 cancels the turn's pending requests when it finalizes (adapter.ts:2063-2070).
      expect(events.filter((event) => event.type === 'resolved')).toMatchObject([{ blockId: 'approval-per_open' }])
    }),
  )

  it.effect('never says a tool ran before it did, and names no tool', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* session.openThread(SESSION)
      fake.push({
        id: 'evt_t1',
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: toolPart('prt_1', 'bash', { status: 'running', input: { command: 'git status' }, time: { start: 1 } }),
          time: 1,
        },
      })
      fake.push({
        id: 'evt_t2',
        type: 'message.part.updated',
        properties: {
          sessionID: SESSION,
          part: toolPart('prt_2', 'task', {
            status: 'running',
            input: { description: 'Find readings', prompt: 'Search', subagent_type: 'general' },
            time: { start: 1 },
          }),
          time: 1,
        },
      })
      yield* until(() => callouts(events).length === 2)
      // T3 types each tool (toolItems.ts:36-63) and keeps running apart from completed (adapter.ts:737-758).
      // The kind's own wording (STL-2), never the tool's name; "task" in "Background task" is the English word.
      expect(callouts(events).map((callout) => [callout.title, callout.body])).toEqual([
        ['Running a command', ''],
        ['Background task', ''],
      ])
    }),
  )

  it.effect('does not speak as an assistant on an approval card', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* session.openThread(SESSION)
      fake.permissions.push(permission('per_w'))
      fake.push({ id: 'evt_p', type: 'permission.asked', properties: permission('per_w') })
      fake.push({
        id: 'evt_q',
        type: 'question.asked',
        properties: {
          id: 'que_w',
          sessionID: SESSION,
          questions: [{ question: 'Which week?', header: 'Week', options: [] }],
        },
      })
      yield* until(() => approvals(events).length === 2)
      // The card's hover shows title and body (Approval.tsx `real`).
      expect(JSON.stringify(approvals(events))).not.toMatch(/assistant/i)
    }),
  )

  it.effect('classifies a provider error instead of passing its text on', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* session.openThread(SESSION)
      yield* send(session, 'Hi')
      fake.push({
        id: 'evt_e',
        type: 'session.error',
        properties: {
          sessionID: SESSION,
          error: {
            name: 'APIError',
            data: {
              message:
                'You exceeded your current quota, please check your plan at https://platform.openai.com/account/billing',
              statusCode: 429,
              isRetryable: false,
            },
          },
        },
      })
      yield* until(() => ended(events).length > 0)
      // T3 classes a 429 as a usage limit (adapter.ts:2691-2696); Docs words the class itself (present.ts),
      // and the provider's text is only the logged detail.
      const [end] = ended(events)
      expect(end).toMatchObject({ failure: { class: 'usage_limit' } })
      expect(end && 'error' in end).toBe(false)
    }),
  )

  // Owned by PAR-E3.
  it.effect.skip('stops the subagents of a turn it stops', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open(WITH_CHILD)
      yield* session.openThread(SESSION)
      yield* send(session, 'Delegate it')
      yield* until(() => events.some((event) => event.type === 'turnStarted'))
      fake.status[CHILD] = { type: 'busy' }
      yield* session.interrupt(SESSION)
      yield* settle
      // "Root abort leaves children running" (T3 adapter.ts:3553-3554 abortDescendants).
      const aborted = fake.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/abort'))
      expect(aborted.map((request) => request.path)).toContain(`/session/${CHILD}/abort`)
    }),
  )
})
