import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import type { AdapterEvent, ProviderSession } from '../provider/ProviderAdapter'
import { agentMessage, makeFakeOpenCode, stubSession, userMessage, type FakeOpenCodeOptions } from './FakeOpenCode'
import * as OpenCodeAdapter from './OpenCodeAdapter'

/**
 * Subagent sessions: their requests reach the document that started them, even when Docs never
 * saw the subagent created, and Stop stops them too (T3 Code's resolveSessionOwner and
 * abortDescendants in packages/provider-opencode/src/server/adapter.ts).
 */

const SETTINGS = { model: 'fake/model-a', effort: null, serviceTier: null, mode: 'build' }
const SESSION = 'ses_1'
const CHILD = 'ses_child'
const GRANDCHILD = 'ses_grandchild'
const HISTORY = {
  sessions: [stubSession(SESSION, 'Reading notes', '/tmp/course')],
  messages: {
    [SESSION]: [
      userMessage(SESSION, 'msg_000000000001u', 'Summarise week 3'),
      agentMessage(SESSION, 'msg_000000000002a', 'Week 3 covers attention.'),
    ],
  },
}
const child = { ...stubSession(CHILD, 'Subtask', '/tmp/course'), parentID: SESSION }
const grandchild = { ...stubSession(GRANDCHILD, 'Sub-subtask', '/tmp/course'), parentID: CHILD }
/** Subagent sessions the server knows about, but Docs never saw created. */
const WITH_CHILDREN = { sessions: [...HISTORY.sessions, child, grandchild] }

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

const approvals = (events: ReadonlyArray<AdapterEvent>) =>
  events.flatMap((event) => (event.type === 'block' && event.block.kind === 'approval' ? [event] : []))

const permission = (id: string, sessionID = SESSION) => ({
  id,
  sessionID,
  permission: 'bash',
  patterns: ['git status'],
  metadata: {},
  always: [],
})

describe('OpenCodeAdapter subagent routing', () => {
  it.effect("restores a subagent's approval that was waiting when the document opens", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* open(WITH_CHILDREN)
      fake.permissions.push(permission('per_grandchild', GRANDCHILD))
      const opened = yield* session.openThread(SESSION)
      expect(opened.blocks.filter((block) => block.kind === 'approval')).toMatchObject([
        { id: 'approval-per_grandchild' },
      ])
    }),
  )

  it.effect('routes an approval from a subagent session Docs never saw created', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open(WITH_CHILDREN)
      yield* session.openThread(SESSION)
      fake.permissions.push(permission('per_live', CHILD))
      fake.push({ id: 'evt_p', type: 'permission.asked', properties: permission('per_live', CHILD) })
      yield* until(() => approvals(events).length === 1)
      // Under the child's id the manager would drop it (no runtime), and the turn would wait forever.
      expect(approvals(events)[0]).toMatchObject({ threadId: SESSION })

      // The lookup is remembered, and its answer reaches the same document.
      const lookups = () => fake.requests.filter((request) => request.path.startsWith('/session/ses_')).length
      const before = lookups()
      yield* session.respond(SESSION, 'approval-per_live', { accept: true, answers: {} })
      fake.permissions.push(permission('per_again', CHILD))
      fake.push({ id: 'evt_p2', type: 'permission.asked', properties: permission('per_again', CHILD) })
      yield* until(() => approvals(events).length === 2)
      expect(approvals(events)[1]).toMatchObject({ threadId: SESSION })
      expect(lookups()).toBe(before)
    }),
  )

  it.effect('asks the server nothing to route a request from an open document', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* session.openThread(SESSION)
      const before = fake.requests.length
      fake.permissions.push(permission('per_own'))
      fake.push({ id: 'evt_p', type: 'permission.asked', properties: permission('per_own') })
      yield* until(() => approvals(events).length === 1)
      expect(approvals(events)[0]).toMatchObject({ threadId: SESSION })
      expect(fake.requests.slice(before)).toEqual([])
    }),
  )

  it.effect('retries routing while a new subagent session cannot be read yet', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* session.openThread(SESSION)
      const gets = () => fake.requests.filter((request) => request.path === `/session/${CHILD}`).length
      fake.permissions.push(permission('per_early', CHILD))
      fake.push({ id: 'evt_p', type: 'permission.asked', properties: permission('per_early', CHILD) })
      yield* until(() => gets() === 1)
      yield* settle
      expect(approvals(events)).toEqual([])

      // The server catches up; the first retry (after 200 ms) finds the parent.
      fake.sessions.push(child)
      yield* TestClock.adjust('200 millis')
      yield* until(() => approvals(events).length === 1)
      expect(approvals(events)[0]).toMatchObject({ threadId: SESSION, block: { id: 'approval-per_early' } })
    }),
  )

  it.effect('stops the subagents of a turn it stops', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open(WITH_CHILDREN)
      yield* session.openThread(SESSION)
      yield* send(session, 'Delegate it')
      yield* until(() => events.some((event) => event.type === 'turnStarted'))
      fake.status[CHILD] = { type: 'busy' }
      fake.status[GRANDCHILD] = { type: 'busy' }
      yield* session.interrupt(SESSION)
      const aborted = fake.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/abort'))
      expect(aborted.map((request) => request.path)).toEqual([
        `/session/${SESSION}/abort`,
        `/session/${CHILD}/abort`,
        `/session/${GRANDCHILD}/abort`,
      ])
      expect(fake.status[CHILD]).toEqual({ type: 'idle' })
      expect(fake.status[GRANDCHILD]).toEqual({ type: 'idle' })
    }),
  )
})
