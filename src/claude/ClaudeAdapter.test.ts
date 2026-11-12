import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { afterAll, describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Logger from 'effect/Logger'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import * as ProcessSupervisor from '../provider/ProcessSupervisor'
import { DEFECT_MESSAGE } from '../provider/errors'
import type {
  LegacyAdapterEvent as AdapterEvent,
  LegacyProviderSession as ProviderSession,
} from '../provider/legacyEvents'
import * as ClaudeAdapter from './ClaudeAdapter'
import {
  assistantFrame,
  makeFakeClaude,
  resultFrame,
  stubSession,
  transcriptAgent,
  transcriptUser,
  type FakeClaudeOptions,
} from './FakeClaude'

const SETTINGS = { model: 'default', effort: 'high', serviceTier: null, mode: null }
const DOC = 'c0ffee00-0000-4000-8000-000000000001'
const HISTORY = {
  sessions: [stubSession(DOC, 'Reading notes', '/tmp')],
  transcripts: {
    [DOC]: [transcriptUser(DOC, 'u1', 'Summarise week 3'), transcriptAgent(DOC, 'a1', 'Week 3 covers attention.')],
  },
}

/** Real time for the fake's promise-based SDK to run; the TestClock still owns deadlines. */
const tick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
const until = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !check(); i += 1) yield* tick
    expect(check()).toBe(true)
  })

const open = (options: FakeClaudeOptions = {}) =>
  Effect.gen(function* () {
    const fake = makeFakeClaude({ ...HISTORY, ...options })
    const session = yield* ClaudeAdapter.make(() => Promise.resolve(fake.sdk)).openSession
    const events: AdapterEvent[] = []
    yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(Effect.forkScoped)
    return { fake, session, events }
  })

const send = (session: ProviderSession, threadId: string, text: string) =>
  session.send(threadId, { text, images: [], skill: null, clientId: session.messageId() }, SETTINGS)

const ended = (events: ReadonlyArray<AdapterEvent>) => events.filter((event) => event.type === 'turnEnded')

describe('ClaudeAdapter', () => {
  it.effect('reads models, efforts and the account from a probe that sends nothing', () =>
    Effect.gen(function* () {
      const { fake, session } = yield* open()
      const catalog = yield* session.loadCatalog
      expect(catalog.models[0]).toMatchObject({
        id: 'default',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        isDefault: true,
      })
      expect(catalog.models[1]).toMatchObject({ id: 'haiku', efforts: [] })
      expect(catalog.account).toEqual({ kind: 'local', label: 'student@example.edu' })
      expect(fake.queries[0]?.prompts).toEqual([])
      expect(fake.queries[0]?.closed).toBe(true)
    }),
  )

  it.effect('says where to sign in when Claude Code has no login', () =>
    Effect.gen(function* () {
      const { session } = yield* open({ account: { tokenSource: 'none' } })
      const error = yield* Effect.flip(session.loadCatalog)
      expect(error._tag).toBe('NotLoggedInError')
      expect(error.message).toMatch(/run `claude` in a terminal/i)
    }),
  )

  it.effect('gives up on a probe that never starts, and closes it', () =>
    Effect.gen(function* () {
      const { fake, session } = yield* open({ hangInit: true })
      const loading = yield* Effect.flip(session.loadCatalog).pipe(Effect.forkScoped)
      yield* tick
      yield* TestClock.adjust(`${ClaudeAdapter.PROBE_SECONDS + 1} seconds`)
      const error = yield* Fiber.join(loading)
      expect(error._tag).toBe('ProviderTimeoutError')
      expect(fake.queries[0]?.closed).toBe(true)
    }),
  )

  it.effect('shares one probe between the catalog and the skills of the same folder', () =>
    Effect.gen(function* () {
      const { fake, session } = yield* open({
        commands: [{ name: 'tutor', description: 'Explains', argumentHint: '' }],
      })
      const [, skills] = yield* Effect.all([session.loadCatalog, session.listSkills(process.env.HOME ?? '/')], {
        concurrency: 'unbounded',
      })
      expect(skills).toEqual([{ name: 'tutor', description: 'Explains', path: '' }])
      expect(fake.queries).toHaveLength(1)
    }),
  )

  it.effect('opens a saved document and pages its earlier blocks', () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 70 }, (_, i) => transcriptUser(DOC, `u${i}`, `Line ${i}`))
      const { fake, session } = yield* open({ transcripts: { [DOC]: many } })
      const opened = yield* session.openThread(DOC)
      expect(opened).toMatchObject({ title: 'Reading notes', cwd: '/tmp', streaming: false })
      expect(opened.blocks).toHaveLength(60)
      const older = yield* session.loadOlder(DOC, opened.olderCursor ?? '')
      expect(older.blocks.map((block) => block.kind === 'user' && block.text)).toEqual(
        Array.from({ length: 10 }, (_, i) => `Line ${i}`),
      )
      expect(older.cursor).toBeNull()
      // Opening reads the transcript; no Claude Code process starts until a message is sent.
      expect(fake.queries).toHaveLength(0)
    }),
  )

  it.effect('streams an answer into one block and resumes the saved transcript', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: () => 'Attention comes first.' })
      yield* session.openThread(DOC)
      yield* send(session, DOC, 'Why?')
      yield* until(() => ended(events).length === 1)

      expect(fake.queries[0]?.options).toMatchObject({
        resume: DOC,
        cwd: '/tmp',
        model: 'default',
        effort: 'high',
        includePartialMessages: true,
      })
      const deltas = events.flatMap((event) => (event.type === 'text' ? [event.delta] : []))
      expect(deltas.join('')).toBe('Attention comes first.')
      // The final frame repeats the streamed text; it is not drawn twice.
      expect(events.some((event) => event.type === 'block' && event.block.kind === 'agent')).toBe(false)
      expect(ended(events)[0]).toEqual({ type: 'turnEnded', threadId: DOC })
    }),
  )

  it.effect('names a new document once its transcript exists', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open()
      const created = yield* session.createThread({ cwd: '/tmp', projectId: null, title: 'Lab 4', settings: SETTINGS })
      yield* session.rename(created.threadId, 'Lab 4 (final)')
      expect(fake.renames).toEqual([])
      yield* send(session, created.threadId, 'Start')
      yield* until(() => ended(events).length === 1)
      expect(fake.queries[0]?.options).toMatchObject({ sessionId: created.threadId })
      expect(fake.renames).toEqual([{ sessionId: created.threadId, title: 'Lab 4 (final)' }])
    }),
  )

  it.effect('ends a turn whose Claude Code exits early, and resumes on the next send', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      yield* session.openThread(DOC)
      yield* send(session, DOC, 'First')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      fake.queries[0]?.exit()
      yield* until(() => ended(events).length === 1)
      expect(ended(events)[0]?.type === 'turnEnded' && ended(events)[0]).toMatchObject({
        error: expect.stringMatching(/stopped before it finished/),
      })

      yield* send(session, DOC, 'Again')
      yield* until(() => fake.queries[1]?.prompts.length === 1)
      expect(fake.queries[1]?.options).toMatchObject({ resume: DOC })
      fake.queries[1]?.exit(new Error('boom'))
      yield* until(() => ended(events).length === 2)
    }),
  )

  it.effect('ends a turn on a frame Docs cannot read with a plain sentence, and logs the cause', () =>
    Effect.gen(function* () {
      const logged: string[] = []
      const capture = Logger.make(({ cause, logLevel }) => {
        if (logLevel === 'Error') logged.push(Cause.pretty(cause))
      })
      yield* Effect.gen(function* () {
        const { fake, session, events } = yield* open({ reply: null })
        yield* send(session, DOC, 'Hi')
        yield* until(() => fake.queries[0]?.prompts.length === 1)
        fake.queries[0]?.push({ type: 'assistant', message: null } as never)
        yield* until(() => ended(events).length === 1)
        expect(ended(events)[0]).toMatchObject({ error: DEFECT_MESSAGE })
      }).pipe(Effect.provide(Logger.layer([capture])))
      expect(logged).toEqual([expect.stringContaining('TypeError')])
    }),
  )

  it.effect('reports a failed result in Claude words', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      yield* send(session, DOC, 'Hi')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      fake.queries[0]?.push(resultFrame({ subtype: 'error_max_turns', is_error: true, errors: [] }))
      yield* until(() => ended(events).length === 1)
      expect(ended(events)[0]).toMatchObject({ error: 'Claude stopped after reaching its step limit.' })
    }),
  )

  it.effect('stops a turn without reporting the abort as an error', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      yield* send(session, DOC, 'Long answer')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      fake.queries[0]?.push(assistantFrame('msg_x', [{ type: 'text', text: 'Partial' }]))
      yield* session.interrupt(DOC)
      fake.queries[0]?.push(
        resultFrame({ subtype: 'error_during_execution', is_error: true, errors: ['Request was aborted.'] }),
      )
      yield* until(() => ended(events).length === 1)
      expect(fake.queries[0]?.calls).toContain('interrupt')
      expect(ended(events)[0]).toEqual({ type: 'turnEnded', threadId: DOC })
    }),
  )

  it.effect('closes a Claude Code that ignores the stop, which ends the turn', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null, hangInterrupt: true })
      yield* send(session, DOC, 'Long answer')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      const stopping = yield* session.interrupt(DOC).pipe(Effect.forkScoped)
      yield* tick
      yield* TestClock.adjust(`${ClaudeAdapter.INTERRUPT_SECONDS + 1} seconds`)
      yield* Fiber.join(stopping)
      expect(fake.queries[0]?.closed).toBe(true)
      expect(ended(events)).toEqual([{ type: 'turnEnded', threadId: DOC }])
    }),
  )

  it.effect('closes a Claude Code that accepts the stop but never ends the turn, so the next send works', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      yield* send(session, DOC, 'Long answer')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      yield* session.interrupt(DOC)
      expect(ended(events)).toEqual([])
      yield* TestClock.adjust(`${ClaudeAdapter.INTERRUPT_SECONDS + 1} seconds`)
      yield* until(() => ended(events).length === 1)
      expect(fake.queries[0]?.closed).toBe(true)
      expect(ended(events)).toEqual([{ type: 'turnEnded', threadId: DOC }])

      yield* send(session, DOC, 'Again')
      yield* until(() => fake.queries[1]?.prompts.length === 1)
    }),
  )

  it.effect('a stop timer left from an earlier turn does not close a later one', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      yield* send(session, DOC, 'First')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      yield* session.interrupt(DOC)
      fake.queries[0]?.push(
        resultFrame({ subtype: 'error_during_execution', is_error: true, errors: ['Request was aborted.'] }),
      )
      yield* until(() => ended(events).length === 1)

      // A new turn, stopped later: only its own timer may close Claude Code.
      yield* TestClock.adjust(`${ClaudeAdapter.INTERRUPT_SECONDS - 2} seconds`)
      yield* send(session, DOC, 'Second')
      yield* until(() => fake.queries[0]?.prompts.length === 2)
      yield* session.interrupt(DOC)
      yield* TestClock.adjust('3 seconds')
      yield* tick
      expect(fake.queries[0]?.closed).toBe(false)
      expect(ended(events)).toHaveLength(1)
      yield* TestClock.adjust(`${ClaudeAdapter.INTERRUPT_SECONDS} seconds`)
      yield* until(() => ended(events).length === 2)
      expect(fake.queries[0]?.closed).toBe(true)
    }),
  )

  it.effect('resumes a new document whose Claude Code exited before answering but kept the transcript', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      const created = yield* session.createThread({ cwd: '/tmp', projectId: null, title: null, settings: SETTINGS })
      yield* send(session, created.threadId, 'First')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      fake.queries[0]?.exit()
      yield* until(() => ended(events).length === 1)

      yield* send(session, created.threadId, 'Again')
      yield* until(() => fake.queries[1]?.prompts.length === 1)
      expect(fake.queries[1]?.options).toMatchObject({ resume: created.threadId })
    }),
  )

  it.effect('asks before a tool runs and passes the answer back', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      yield* send(session, DOC, 'Run it')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      const asked = fake.queries[0]!.askTool('Bash', { command: 'git status' }, 'toolu_1')
      yield* until(() => events.some((event) => event.type === 'block' && event.block.kind === 'approval'))
      expect(events.find((event) => event.type === 'block')).toMatchObject({
        threadId: DOC,
        block: { id: 'approval-toolu_1', title: 'Allow Bash?', body: 'git status', resolved: null },
      })
      yield* session.respond(DOC, 'approval-toolu_1', { accept: true, answers: {} })
      expect(yield* Effect.promise(() => asked.result)).toEqual({
        behavior: 'allow',
        updatedInput: { command: 'git status' },
      })
    }),
  )

  it.effect("never puts the SDK's own prompt sentences, or a vendor-named MCP server, on the card", () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      yield* send(session, DOC, 'Look it up')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      const prompt = {
        title: 'Claude wants to search the web',
        description: 'Claude will have access to the web',
        decisionReason: 'Claude Code asks before searching',
      }
      fake.queries[0]!.askTool('WebSearch', { query: 'week 3 readings' }, 'toolu_w', {
        ...prompt,
        displayName: 'Search the web',
      })
      fake.queries[0]!.askTool('mcp__claude_ai_Notion__notion-search', { query: 'notes' }, 'toolu_m', {
        ...prompt,
        displayName: 'Claude: search Notion',
      })
      fake.queries[0]!.askTool('mcp__x__claude_search', { query: 'syllabus' }, 'toolu_c', prompt)
      // A Task card shows its short description, and a long input is clipped.
      fake.queries[0]!.askTool(
        'Task',
        { description: 'Summarize week 3', prompt: 'Read every file. '.repeat(40) },
        'toolu_t',
        prompt,
      )
      fake.queries[0]!.askTool('Bash', { command: 'x'.repeat(500) }, 'toolu_b', prompt)
      yield* until(() => events.filter((event) => event.type === 'block').length === 5)
      const cards = events.flatMap((event) =>
        event.type === 'block' && event.block.kind === 'approval' ? [event.block] : [],
      )
      expect(cards.map((card) => [card.title, card.body])).toEqual([
        ['Allow Search the web?', 'week 3 readings'],
        ['Allow notion-search?', 'notes'],
        ['Allow this tool?', 'syllabus'],
        ['Allow Task?', 'Summarize week 3'],
        ['Allow Bash?', `${'x'.repeat(199)}…`],
      ])
      for (const card of cards) expect(JSON.stringify(card)).not.toMatch(/claude|anthropic/i)
    }),
  )

  it.effect('refuses a tool whose request Docs cannot show, and logs the cause through the session’s logger', () =>
    Effect.gen(function* () {
      const logged: string[] = []
      const capture = Logger.make(({ cause, logLevel }) => {
        if (logLevel === 'Error') logged.push(Cause.pretty(cause))
      })
      yield* Effect.gen(function* () {
        const { fake, session } = yield* open({ reply: null })
        yield* send(session, DOC, 'Run it')
        yield* until(() => fake.queries[0]?.prompts.length === 1)
        const input = Object.defineProperty({}, 'command', {
          enumerable: true,
          get: () => {
            throw new Error('preview bug')
          },
        })
        const asked = fake.queries[0]!.askTool('Bash', input, 'toolu_1')
        expect(yield* Effect.promise(() => asked.result)).toEqual({ behavior: 'deny', message: DEFECT_MESSAGE })
      }).pipe(Effect.provide(Logger.layer([capture])))
      expect(logged).toEqual([expect.stringContaining('preview bug')])
    }),
  )

  it.effect('answers AskUserQuestion by question text, and withdraws a request when the turn stops', () =>
    Effect.gen(function* () {
      const { fake, session, events } = yield* open({ reply: null })
      yield* send(session, DOC, 'Quiz me')
      yield* until(() => fake.queries[0]?.prompts.length === 1)
      const input = {
        questions: [
          {
            question: 'Which week?',
            header: 'Week',
            options: [
              { label: '3', description: '' },
              { label: '4', description: '' },
            ],
            multiSelect: false,
          },
        ],
      }
      const asked = fake.queries[0]!.askTool('AskUserQuestion', input, 'toolu_q')
      yield* until(() => events.some((event) => event.type === 'block'))
      expect(events.find((event) => event.type === 'block')).toMatchObject({
        block: { questions: [{ id: 'q0', question: 'Which week?', options: ['3', '4'], allowText: true }] },
      })
      yield* session.respond(DOC, 'approval-toolu_q', { accept: true, answers: { q0: '3' } })
      expect(yield* Effect.promise(() => asked.result)).toEqual({
        behavior: 'allow',
        updatedInput: { ...input, answers: { 'Which week?': '3' } },
      })

      const withdrawn = fake.queries[0]!.askTool('Bash', { command: 'ls' }, 'toolu_2')
      yield* until(() => events.filter((event) => event.type === 'block').length === 2)
      withdrawn.abort()
      expect(yield* Effect.promise(() => withdrawn.result)).toMatchObject({ behavior: 'deny' })
      yield* until(() => events.some((event) => event.type === 'resolved'))
      expect(events.find((event) => event.type === 'resolved')).toMatchObject({
        blockId: 'approval-toolu_2',
        resolved: 'skipped',
      })
    }),
  )

  describe('under the process supervisor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hidegpt-claude-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    const groupAlive = (pid: number) => {
      try {
        process.kill(-pid, 0)
        return true
      } catch {
        return false
      }
    }
    const ledgerAt = (path: string): Record<string, { owner: number }> => {
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        return {}
      }
    }
    const waitFor = (check: () => boolean) =>
      Effect.gen(function* () {
        for (let i = 0; i < 150 && !check(); i += 1) yield* Effect.sleep('20 millis')
        expect(check()).toBe(true)
      })

    it.live(
      'spawns Claude Code through the supervisor: in the ledger while it runs, its group killed by the library’s scope',
      () =>
        Effect.gen(function* () {
          const ledger = join(dir, 'provider-processes.json')
          // `sleep` stands in for the CLI, with a grandchild in its group; no prompt reaches any model. It ignores
          // SIGTERM, so closing the query (which aborts the spawn signal) cannot end it: only the supervisor's
          // scope finalizer can, by escalating to SIGKILL on the whole group.
          const fake = makeFakeClaude({
            ...HISTORY,
            reply: null,
            process: { command: '/bin/sh', args: ['-c', "trap '' TERM; sleep 30 & wait"] },
          })
          const supervisor = yield* ProcessSupervisor.ProcessSupervisor
          const scope = yield* Scope.make()
          const session = yield* ClaudeAdapter.make(() => Promise.resolve(fake.sdk), supervisor).openSession.pipe(
            Scope.provide(scope),
          )
          yield* send(session, DOC, 'Summarise week 4')
          const pid = fake.queries[0]?.child?.pid ?? 0
          expect(pid).toBeGreaterThan(0)
          expect(fake.queries[0]?.options.stderr).toBeUndefined()
          yield* waitFor(() => ledgerAt(ledger)[pid]?.owner === process.pid)
          expect(groupAlive(pid)).toBe(true)

          yield* Scope.close(scope, Exit.void)
          // Scope.close returns once the finalizer has sent SIGKILL (after FORCE_KILL_AFTER).
          yield* waitFor(() => !groupAlive(pid))
          yield* waitFor(() => ledgerAt(ledger)[pid] === undefined)
        }).pipe(
          Effect.provide(ProcessSupervisor.layer(join(dir, 'provider-processes.json'))),
          Effect.provide(NodeServices.layer),
        ),
    )
  })
})
