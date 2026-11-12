import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Logger from 'effect/Logger'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import type { AdapterEvent, ProviderSession } from '../provider/ProviderAdapter'
import { agentMessage, makeFakeOpenCode, stubSession, userMessage, type FakeOpenCode, type FakeOpenCodeOptions } from './FakeOpenCode'
import { readableProviderError } from './mapping'
import * as OpenCodeAdapter from './OpenCodeAdapter'

const SETTINGS = { model: 'fake/model-a', effort: null, serviceTier: null, mode: 'build' }
const SESSION = 'ses_1'
const HISTORY = {
  sessions: [stubSession(SESSION, 'Reading notes', '/tmp/course')],
  messages: { [SESSION]: [userMessage(SESSION, 'msg_000000000001u', 'Summarise week 3'), agentMessage(SESSION, 'msg_000000000002a', 'Week 3 covers attention.')] },
}

/** Real time for the fake's promise-based HTTP and SSE to run; the TestClock still owns timeouts. */
const tick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
const until = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !check(); i += 1) yield* tick
    expect(check()).toBe(true)
  })

/** Opens a session against the in-process server; events are collected as they arrive. */
const open = (options: FakeOpenCodeOptions = {}) =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode({ ...HISTORY, ...options })
    const session = yield* OpenCodeAdapter.make(fake.connect).openSession
    const events: AdapterEvent[] = []
    yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(Effect.forkScoped)
    return { fake, session, events }
  })

const send = (session: ProviderSession, text: string) =>
  Effect.gen(function* () {
    const clientId = session.messageId()
    yield* session.send(SESSION, { text, images: [], skill: null, clientId }, SETTINGS)
    return clientId
  })

const requested = (fake: FakeOpenCode, method: string, path: string) =>
  fake.requests.filter((request) => request.method === method && request.path === path)

const permission = (id: string, sessionID = SESSION) => ({
  id,
  sessionID,
  permission: 'bash',
  patterns: ['git status'],
  metadata: {},
  always: [],
})

describe('OpenCodeAdapter', () => {
  it.effect('loads models, the default model and the primary agents', () =>
    Effect.gen(function* () {
      const { session } = yield* open()
      const catalog = yield* session.loadCatalog
      expect(catalog.models).toMatchObject([{ id: 'fake/model-a', label: 'Model A', isDefault: true }])
      expect(catalog.modes).toEqual([{ id: 'build', label: 'build' }])
      expect(catalog.defaultMode).toBe('build')
      expect(catalog.account).toBeNull()
    }),
  )

  it.effect('surfaces a library with no model providers instead of showing it empty', () =>
    Effect.gen(function* () {
      const { session } = yield* open({ providers: [] })
      const error = yield* Effect.flip(session.loadCatalog)
      expect(error._tag).toBe('NotLoggedInError')
      expect(error.message).toMatch(/opencode auth login/)
    }),
  )

  it.effect('streams a turn under the id Docs sent, without re-reading the messages', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: () => 'Attention comes first.' })
      yield* session.openThread(SESSION)
      const reads = requested(fake, 'GET', `/session/${SESSION}/message`).length
      const clientId = yield* send(session, 'Why?')
      yield* until(() => events.some((event) => event.type === 'turnEnded'))

      const prompt = requested(fake, 'POST', `/session/${SESSION}/prompt_async`)[0]
      expect(prompt?.body).toMatchObject({ messageID: clientId, model: { providerID: 'fake', modelID: 'model-a' }, agent: 'build' })
      expect(prompt?.query.get('directory')).toBe('/tmp/course')
      expect(clientId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{28}$/)
      // The echo already shows the question: no user block, and no extra GET to reconcile it.
      expect(events.some((event) => event.type === 'block' && event.block.kind === 'user')).toBe(false)
      expect(requested(fake, 'GET', `/session/${SESSION}/message`).length).toBe(reads)

      const deltas = events.flatMap((event) => (event.type === 'text' ? [event.delta] : []))
      expect(deltas.join('')).toBe('Attention comes first.')
      expect(events.findLast((event) => event.type === 'block')).toMatchObject({
        block: { kind: 'agent', text: 'Attention comes first.' },
      })
      expect(events.map((event) => event.type)).toContain('turnStarted')
    }),
  )

  it.effect('never shows reasoning, even though its deltas use the text field', () =>
    Effect.gen(function* () {
      const { fake, events } = yield* open({ reply: null })
      const part = { id: 'prt_r', sessionID: SESSION, messageID: 'msg_r', type: 'reasoning' as const, text: '', time: { start: 0 } }
      fake.push({ id: 'evt_1', type: 'message.part.updated', properties: { sessionID: SESSION, part, time: 0 } })
      fake.push({ id: 'evt_2', type: 'message.part.delta', properties: { sessionID: SESSION, messageID: 'msg_r', partID: 'prt_r', field: 'text', delta: 'secret plan' } })
      fake.push({ id: 'evt_3', type: 'session.idle', properties: { sessionID: SESSION } })
      yield* until(() => events.some((event) => event.type === 'turnEnded'))
      expect(events.filter((event) => event.type === 'text' || event.type === 'block')).toEqual([])
    }),
  )

  it.effect('shows a question typed in another client (the OpenCode TUI)', () =>
    Effect.gen(function* () {
      const { fake, events } = yield* open({ reply: null })
      const message = userMessage(SESSION, 'msg_tui', 'Typed in the terminal')
      fake.push({ id: 'evt_m', type: 'message.updated', properties: { sessionID: SESSION, info: message.info } })
      fake.push({ id: 'evt_p', type: 'message.part.updated', properties: { sessionID: SESSION, part: message.parts[0]!, time: 0 } })
      yield* until(() => events.some((event) => event.type === 'block'))
      expect(events.find((event) => event.type === 'block')).toMatchObject({
        block: { kind: 'user', id: 'msg_tui', text: 'Typed in the terminal' },
      })
    }),
  )

  it.effect('adds no duplicate question when the server ignores the id Docs sent', () =>
    Effect.gen(function* () {
      const { session, events } = yield* open({ ignoreMessageIds: true, reply: () => 'Ok.' })
      yield* send(session, 'From Docs')
      yield* until(() => events.some((event) => event.type === 'turnEnded'))
      expect(events.some((event) => event.type === 'block' && event.block.kind === 'user')).toBe(false)
    }),
  )

  it.effect('restores approvals that were already waiting when the document opens', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      fake.permissions.push(permission('per_1'), permission('per_other', 'ses_elsewhere'))
      const opened = yield* session.openThread(SESSION)
      const approvals = opened.blocks.filter((block) => block.kind === 'approval')
      expect(approvals).toMatchObject([{ id: 'approval-per_1', title: 'Allow bash: git status?', resolved: null }])

      yield* session.respond(SESSION, 'approval-per_1', { accept: true, answers: {} })
      expect(requested(fake, 'POST', '/permission/per_1/reply')[0]?.body).toEqual({ reply: 'once' })
      yield* until(() => fake.permissions.length === 1)
      yield* Effect.repeat(tick, { times: 5 })
      // Docs answered it, so the server's `replied` event is not reported as news.
      expect(events.filter((event) => event.type === 'resolved')).toEqual([])
    }),
  )

  it.effect('keeps an approval open when OpenCode does not take the answer', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      fake.replyResult = false
      fake.permissions.push(permission('per_2'))
      fake.push({ id: 'evt_p', type: 'permission.asked', properties: permission('per_2') })
      yield* until(() => events.some((event) => event.type === 'block' && event.block.kind === 'approval'))

      const failed = yield* Effect.flip(session.respond(SESSION, 'approval-per_2', { accept: true, answers: {} }))
      expect(failed.message).toBe('OpenCode did not take that answer. Try again.')
      fake.replyResult = true
      yield* session.respond(SESSION, 'approval-per_2', { accept: true, answers: {} })
      expect(requested(fake, 'POST', '/permission/per_2/reply')).toHaveLength(2)
    }),
  )

  it.effect('answers questions in order, and routes a subagent question to the open document', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      const child = stubSession('ses_child', 'Subtask', '/tmp/course')
      fake.push({ id: 'evt_c', type: 'session.created', properties: { sessionID: child.id, info: { ...child, parentID: SESSION } } })
      const request = {
        id: 'que_1',
        sessionID: 'ses_child',
        questions: [
          { question: 'Which week?', header: 'Week', options: [{ label: '3', description: '' }] },
          { question: 'Anything else?', header: 'Extra', options: [] },
        ],
      }
      fake.questions.push(request)
      fake.push({ id: 'evt_q', type: 'question.asked', properties: request })
      yield* until(() => events.some((event) => event.type === 'block' && event.block.kind === 'approval'))
      expect(events.find((event) => event.type === 'block')).toMatchObject({ threadId: SESSION, block: { id: 'approval-que_1' } })

      yield* session.respond(SESSION, 'approval-que_1', { accept: true, answers: { q0: '3' } })
      expect(requested(fake, 'POST', '/question/que_1/reply')[0]?.body).toEqual({ answers: [['3'], []] })
    }),
  )

  it.effect('resubscribes when the update stream closes, and reloads the open document', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      yield* session.openThread(SESSION)
      fake.endStreams()
      yield* TestClock.adjust('1 second')
      yield* until(() => events.some((event) => event.type === 'reset'))
      expect(fake.subscriptions()).toBe(2)
      expect(events.find((event) => event.type === 'reset')).toMatchObject({ threadId: SESSION, streaming: false })
      expect(events.map((event) => event.type)).toContain('turnEnded')
    }),
  )

  it.effect('treats a silent stream as stalled and resubscribes', () =>
    Effect.gen(function* () {
      const { fake } = yield* open({ reply: null })
      yield* tick
      yield* TestClock.adjust(OpenCodeAdapter.WATCHDOG)
      yield* TestClock.adjust('1 second')
      yield* until(() => fake.subscriptions() === 2)
    }),
  )

  it.effect('ends the session when the server process exits', () =>
    Effect.gen(function* () {
      const { fake, session } = yield* open()
      const exit = yield* session.awaitExit.pipe(Effect.exit, Effect.forkScoped)
      fake.exit(1)
      const result = yield* Fiber.join(exit)
      expect(Exit.isFailure(result) && Exit.hasFails(result)).toBe(true)
      const error = yield* Effect.flip(session.awaitExit)
      expect(error._tag).toBe('ProcessExitedError')
    }),
  )

  it.effect('a defect while reading updates ends the session with a plain sentence and a logged report', () => {
    const logged: string[] = []
    const capture = Logger.make(({ cause, logLevel }) => {
      if (logLevel === 'Error') logged.push(Cause.pretty(cause))
    })
    return Effect.gen(function* () {
      const { fake, session } = yield* open()
      // A malformed update: reading `info.role` throws inside the event mapping.
      fake.push({ id: 'evt_bad', type: 'message.updated', properties: { sessionID: SESSION } } as never)
      const error = yield* Effect.flip(session.awaitExit)
      expect(error).toMatchObject({ _tag: 'ProviderDefectError', message: 'Something went wrong. Docs saved a report and is reconnecting.' })
      expect(logged).toEqual([expect.stringContaining("reading 'role'")])
    }).pipe(Effect.provide(Logger.layer([capture])))
  })

  it.effect('times out a request the server never answers', () =>
    Effect.gen(function* () {
      const hold = new Promise<void>(() => {})
      const { session } = yield* open({ hold: (method, path) => (path === `/session/${SESSION}` ? hold : undefined) })
      const opening = yield* Effect.flip(session.openThread(SESSION)).pipe(Effect.forkScoped)
      yield* tick
      yield* TestClock.adjust('31 seconds')
      const error = yield* Fiber.join(opening)
      expect(error._tag).toBe('ProviderTimeoutError')
    }),
  )

  it.effect('sends a chosen skill as a hidden part and shows its name when reopened', () =>
    Effect.gen(function* () {
      const skill = { name: 'tutor', description: 'Explains slowly', location: '/skills/tutor/SKILL.md', content: 'Go slowly.' }
      const { fake, session } = yield* open({ reply: null, skills: [skill] })
      const [listed] = yield* session.listSkills('/tmp/course')
      yield* session.send(SESSION, { text: 'Explain', images: [], skill: listed ?? null, clientId: session.messageId() }, SETTINGS)

      const parts = (requested(fake, 'POST', `/session/${SESSION}/prompt_async`)[0]!.body as { parts: Array<{ synthetic?: boolean; text: string }> }).parts
      expect(parts[1]).toMatchObject({ synthetic: true })
      expect(parts[1]?.text).toContain('Go slowly.')
      const reopened = yield* session.openThread(SESSION)
      expect(reopened.blocks.at(-1)).toMatchObject({ kind: 'user', text: 'Explain', skills: ['tutor'] })
    }),
  )

  it.effect('ends the turn with the model error, but not when Docs stopped it', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      yield* send(session, 'First')
      fake.push({ id: 'evt_e', type: 'session.error', properties: { sessionID: SESSION, error: { name: 'APIError', data: { message: 'Rate limited.', isRetryable: false } } } })
      yield* until(() => events.some((event) => event.type === 'turnEnded'))
      expect(events.find((event) => event.type === 'turnEnded')).toMatchObject({ error: 'Rate limited.' })

      events.length = 0
      yield* send(session, 'Second')
      yield* session.interrupt(SESSION)
      yield* until(() => events.some((event) => event.type === 'turnEnded'))
      expect(requested(fake, 'POST', `/session/${SESSION}/abort`)).toHaveLength(1)
      expect(events.find((event) => event.type === 'turnEnded')).not.toHaveProperty('error', expect.any(String))
    }),
  )

  it.effect('starts a turn once, however often OpenCode repeats busy or retry', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      const status = (id: string, type: 'busy' | 'retry' | 'idle') =>
        fake.push({ id, type: 'session.status', properties: { sessionID: SESSION, status: type === 'retry' ? { type, attempt: 1, message: 'Overloaded', next: 0 } : { type } } })
      const started = () => events.filter((event) => event.type === 'turnStarted').length
      yield* send(session, 'First')
      yield* until(() => started() === 1)
      status('evt_s1', 'retry')
      status('evt_s2', 'busy')
      status('evt_s3', 'idle')
      yield* until(() => events.some((event) => event.type === 'turnEnded'))
      expect(started()).toBe(1)

      status('evt_s4', 'busy')
      yield* until(() => started() === 2)
    }),
  )

  it.effect('declines a permission with a reject reply and a question with reject', () =>
    Effect.gen(function* () {
      const { fake, session } = yield* open({ reply: null })
      fake.permissions.push(permission('per_3'))
      fake.questions.push({ id: 'que_2', sessionID: SESSION, questions: [{ question: 'Go on?', header: 'Go', options: [] }] })
      yield* session.openThread(SESSION)
      yield* session.respond(SESSION, 'approval-per_3', { accept: false, answers: {} })
      yield* session.respond(SESSION, 'approval-que_2', { accept: false, answers: {} })
      expect(requested(fake, 'POST', '/permission/per_3/reply')[0]?.body).toEqual({ reply: 'reject' })
      expect(requested(fake, 'POST', '/question/que_2/reject')).toHaveLength(1)
      // A second answer for the same request is refused locally.
      const again = yield* Effect.flip(session.respond(SESSION, 'approval-per_3', { accept: true, answers: {} }))
      expect(again.message).toMatch(/no longer waiting/)
    }),
  )

  it.effect('reports a turn the server refuses, in Docs words', () =>
    Effect.gen(function* () {
      const { session } = yield* open({ reply: null })
      const error = yield* Effect.flip(
        session.send('ses_missing', { text: 'Hi', images: [], skill: null, clientId: session.messageId() }, SETTINGS),
      )
      expect(error.message).toMatch(/could not find that document/)
    }),
  )

  it.effect('creates a document in the chosen folder and saves renames', () =>
    Effect.gen(function* () {
      const { fake, session } = yield* open({ reply: null })
      const created = yield* session.createThread({ cwd: '/tmp/new', projectId: null, title: 'Lab 4', settings: SETTINGS })
      const create = requested(fake, 'POST', '/session')[0]
      expect(create?.query.get('directory')).toBe('/tmp/new')
      expect(create?.body).toMatchObject({ title: 'Lab 4', agent: 'build', model: { providerID: 'fake', id: 'model-a' } })
      yield* session.rename(created.threadId, 'Lab 4 (final)')
      expect(requested(fake, 'PATCH', `/session/${created.threadId}`)[0]?.body).toEqual({ title: 'Lab 4 (final)' })
    }),
  )

  it.effect('pages earlier messages with the server cursor', () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 70 }, (_, i) => userMessage(SESSION, `msg_${String(i).padStart(12, '0')}`, `Line ${i}`))
      const { session } = yield* open({ messages: { [SESSION]: many } })
      const opened = yield* session.openThread(SESSION)
      expect(opened.blocks).toHaveLength(60)
      expect(opened.olderCursor).not.toBeNull()
      const older = yield* session.loadOlder(SESSION, opened.olderCursor ?? '')
      expect(older.blocks.map((block) => block.kind === 'user' && block.text)).toEqual(Array.from({ length: 10 }, (_, i) => `Line ${i}`))
      expect(older.cursor).toBeNull()
    }),
  )
})

describe('OpenCode error sentences', () => {
  // The shapes the SDK's `throwOnError` and fetch produce (see the SDK's error-interceptor).
  const rejection = (cause: unknown, message = 'opencode server failed') => new Error(message, { cause })

  it('reads the error body the SDK attaches, and falls back on anything else', () => {
    const cases: Array<[unknown, string]> = [
      [rejection({ status: 404, body: { name: 'NotFoundError', data: { message: 'Session not found: ses_1' } } }), 'OpenCode could not find that document.'],
      [rejection({ status: 400, body: { name: 'BadRequest', data: { message: ' Model is not set up. ' } } }), 'Model is not set up.'],
      [rejection({ status: 500, body: { message: 'Server broke.' } }), 'Server broke.'],
      [rejection({ status: 500, body: { data: { message: 42 } } }), 'OpenCode did not accept that request.'],
      [rejection({ status: undefined, body: undefined }), 'OpenCode did not accept that request.'],
      [rejection(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }), 'request failed'), 'OpenCode is not responding.'],
      [rejection(undefined, 'fetch failed'), 'OpenCode is not responding.'],
      [rejection(undefined, 'Something else.'), 'Something else.'],
      ['not an error', 'OpenCode did not accept that request.'],
    ]
    expect(cases.map(([cause]) => OpenCodeAdapter.errorDetail(cause))).toEqual(cases.map(([, sentence]) => sentence))
  })

  it("decodes a model provider's error data, ignoring a malformed one", () => {
    const html = '<html><title>Bad   Gateway</title></html>'
    expect(readableProviderError({ name: 'APIError', data: { message: 'Rate limited.' } })).toBe('Rate limited.')
    expect(readableProviderError({ name: 'APIError', data: { message: '<none>', statusCode: 502, responseBody: html } })).toBe(
      'Bad Gateway (HTTP 502).',
    )
    expect(readableProviderError({ name: 'APIError', data: { statusCode: 503 } })).toBe('The model provider failed the request (HTTP 503).')
    expect(readableProviderError({ name: 'APIError', data: { message: 7 } })).toBe('APIError')
    expect(readableProviderError(undefined)).toBe('The assistant ran into an error.')
  })
})
