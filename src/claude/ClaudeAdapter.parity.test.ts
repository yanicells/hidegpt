import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'

import type {
  LegacyAdapterEvent as AdapterEvent,
  LegacyProviderSession as ProviderSession,
} from '../provider/legacyEvents'
import * as ClaudeAdapter from './ClaudeAdapter'
import {
  assistantFrame,
  makeFakeClaude,
  resultFrame,
  streamEvent,
  stubSession,
  transcriptAgent,
  transcriptUser,
  type FakeClaudeOptions,
} from './FakeClaude'

/**
 * Protocol cases T3 Code's Claude adapter handles (ClaudeAdapterV2.ts at 5c6f2f12) that this
 * adapter did not. Each test states the behaviour Docs needs; the skipped ones name the
 * package that builds them (research/reports/fable-provider-parity.md, section 3).
 */

const SETTINGS = { model: 'default', effort: 'high', serviceTier: null, mode: null }
const DOC = 'c0ffee00-0000-4000-8000-000000000001'
const HISTORY = {
  sessions: [stubSession(DOC, 'Reading notes', '/tmp')],
  transcripts: {
    [DOC]: [transcriptUser(DOC, 'u1', 'Summarise week 3'), transcriptAgent(DOC, 'a1', 'Week 3 covers attention.')],
  },
}

const tick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
const settle = Effect.repeat(tick, { times: 10 })
const until = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !check(); i += 1) yield* tick
    expect(check()).toBe(true)
  })

const open = (options: FakeClaudeOptions = {}) =>
  Effect.gen(function* () {
    const fake = makeFakeClaude({ ...HISTORY, reply: null, ...options })
    const session = yield* ClaudeAdapter.make(() => Promise.resolve(fake.sdk)).openSession
    const events: AdapterEvent[] = []
    yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(Effect.forkScoped)
    return { fake, session, events }
  })

const send = (session: ProviderSession, threadId: string, text: string) =>
  session.send(threadId, { text, images: [], skill: null, clientId: session.messageId() }, SETTINGS)

const started = (events: ReadonlyArray<AdapterEvent>) => events.filter((event) => event.type === 'turnStarted')
const ended = (events: ReadonlyArray<AdapterEvent>) => events.filter((event) => event.type === 'turnEnded')
/** Everything an event can put on the page: block titles, bodies and streamed text. */
const pageText = (events: ReadonlyArray<AdapterEvent>) =>
  events
    .flatMap((event) =>
      event.type === 'block' ? [JSON.stringify(event.block)] : event.type === 'text' ? [event.delta] : [],
    )
    .join('\n')

/** A notice Claude Code writes itself: an assistant frame from the model "<synthetic>". */
const cliNotice = (text: string, error: string) =>
  ({
    ...assistantFrame('msg_notice', [{ type: 'text', text }]),
    message: { id: 'msg_notice', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
    error,
  }) as never

describe('ClaudeAdapter parity with T3 Code', () => {
  it.effect('keeps a Claude Code notice (a usage limit) out of the document', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* send(session, DOC, 'Hi')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      const notice = "You've hit your session limit · resets 3pm"
      fake.queries[0]?.push(cliNotice(notice, 'rate_limit'))
      fake.queries[0]?.push(resultFrame({ is_error: true, result: notice, api_error_status: 429 }))
      yield* until(() => ended(events).length === 1)
      // T3 reads `<synthetic>` frames as CLI notices and classifies them (ClaudeAdapterV2.ts:9882-9913).
      expect(pageText(events)).not.toContain('session limit')
    }),
  )

  it.effect('keeps a sign-in notice out of the document and out of the error text', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* send(session, DOC, 'Hi')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      const notice = 'Please run /login · API Error: 401 authentication_error'
      fake.queries[0]?.push(cliNotice(notice, 'authentication_failed'))
      fake.queries[0]?.push(resultFrame({ is_error: true, result: notice, api_error_status: 401 }))
      yield* until(() => ended(events).length === 1)
      expect(pageText(events)).not.toContain('/login')
      // The error is a class Docs words itself (present.ts); the provider's sentence is only the logged detail.
      const [end] = ended(events)
      expect(end).toMatchObject({ failure: { class: 'auth' } })
      expect(end && 'error' in end).toBe(false)
    }),
  )

  it.effect('names no tool, vendor or subagent in a callout', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* send(session, DOC, 'Look it up')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      fake.queries[0]?.push(
        assistantFrame('msg_t', [
          { type: 'tool_use', id: 'toolu_m', name: 'mcp__claude_ai_Notion__notion-search', input: { query: 'notes' } },
          {
            type: 'tool_use',
            id: 'toolu_a',
            name: 'Agent',
            input: { subagent_type: 'general-purpose', description: 'Find readings', prompt: 'Search the repo' },
          },
          {
            type: 'tool_use',
            id: 'toolu_t',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Read', status: 'pending' }] },
          },
        ]),
      )
      yield* until(() => events.some((event) => event.type === 'block'))
      yield* settle
      // T3 classifies every native tool (ClaudeAdapterV2.ts:3221-3246); the page shows the kind, never the name.
      expect(pageText(events)).not.toMatch(/claude|anthropic|mcp__|subagent|TodoWrite|Used Agent|Using Agent/i)
    }),
  )

  it.effect('draws no callout for a question the card already asks', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* send(session, DOC, 'Ask me')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      const input = { questions: [{ question: 'Which week?', header: 'Week', options: [{ label: '3' }] }] }
      fake.queries[0]?.push(
        assistantFrame('msg_q', [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input }]),
      )
      fake.queries[0]!.askTool('AskUserQuestion', input, 'toolu_q')
      yield* until(() => events.some((event) => event.type === 'block' && event.block.kind === 'approval'))
      yield* settle
      expect(events.filter((event) => event.type === 'block' && event.block.kind === 'callout')).toEqual([])
    }),
  )

  it.effect('shows the plan it asks the person to approve', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* send(session, DOC, 'Plan it')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      fake.queries[0]!.askTool('ExitPlanMode', { plan: '1. Read the notes\n2. Write the summary' }, 'toolu_p')
      yield* until(() => events.some((event) => event.type === 'block' && event.block.kind === 'approval'))
      const card = events.flatMap((event) =>
        event.type === 'block' && event.block.kind === 'approval' ? [event.block] : [],
      )[0]
      // T3 captures the plan from ExitPlanMode (ClaudeAdapterV2.ts:11237-11255) instead of a bare tool prompt.
      expect(card?.title).toBe('Review the plan?')
      expect(card?.body).toContain('Read the notes')
    }),
  )

  // Owned by PAR-B item 1 (ARCH-4b).
  it.effect.skip("a background task's bookkeeping result does not end the person's turn", () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* send(session, DOC, 'Run the long job')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      fake.queries[0]?.push(
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working on it' } }),
      )
      // T3 drops this frame: it "ends no turn" (ClaudeAdapterV2.ts:4287-4297, :10716-10732).
      fake.queries[0]?.push(resultFrame({ origin: { kind: 'task-notification' }, num_turns: 0 }))
      yield* settle
      expect(ended(events)).toEqual([])
    }),
  )

  // Owned by PAR-B item 2 (ARCH-4b).
  it.effect.skip('shows work Claude Code starts on its own as a running turn', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* send(session, DOC, 'Start a background job')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      fake.queries[0]?.push(resultFrame())
      yield* until(() => ended(events).length === 1)
      // A finished background task wakes the session with no prompt from Docs.
      fake.queries[0]?.push(assistantFrame('msg_wake', [{ type: 'text', text: 'The job finished.' }]))
      yield* until(() => events.some((event) => event.type === 'block' && event.block.kind === 'agent'))
      // The page must show Working and Stop for it (T3 trap: "work the provider starts on its own").
      expect(started(events)).toHaveLength(2)
    }),
  )

  // Owned by PAR-B item 3 (ARCH-4b).
  it.effect.skip('a Stop pressed before the turn started still stops it', () =>
    Effect.gen(function* () {
      const fake = makeFakeClaude({ ...HISTORY, reply: null })
      let release = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      // Starting a new document's process first asks whether a transcript exists; hold that answer.
      const sdk: ClaudeAdapter.ClaudeSdk = {
        ...fake.sdk,
        getSessionInfo: async (...args) => {
          await gate
          return fake.sdk.getSessionInfo(...args)
        },
      }
      const session = yield* ClaudeAdapter.make(() => Promise.resolve(sdk)).openSession
      const created = yield* session.createThread({ cwd: '/tmp', title: null, settings: SETTINGS } as never)
      const sending = yield* send(session, created.threadId, 'Hi').pipe(Effect.forkScoped)
      yield* settle
      yield* session.interrupt(created.threadId)
      release()
      yield* Fiber.join(sending)
      yield* settle
      const query = fake.queries[0]
      // T3 holds the Stop until the turn exists, then stops it (adding-a-provider.md, "Stop sent before the turn started").
      expect(query === undefined || query.prompts.length === 0 || query.calls.includes('interrupt')).toBe(true)
    }),
  )

  // Owned by PAR-B item 6 (ARCH-4b).
  it.effect.skip('tells the page when the provider is retrying or rate limited', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      yield* send(session, DOC, 'Hi')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      const before = events.length
      fake.queries[0]?.push({
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 5000,
        error_status: 529,
        error: 'overloaded',
        uuid: 'r1',
        session_id: '',
      } as never)
      fake.queries[0]?.push({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1900000000, rateLimitType: 'five_hour' },
        uuid: 'r2',
        session_id: '',
      } as never)
      yield* settle
      // T3 shows a retry item that clears (ClaudeAdapterV2.ts:10103-10149) and a usage-limit notice (:9610-9695).
      expect(events.length).toBeGreaterThan(before)
    }),
  )
})
