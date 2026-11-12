import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'

import type { AdapterEvent, ProviderSession, TurnSettings } from '../provider/ProviderAdapter'
import { readTranscript, type ReplayEntry, type ReplayTranscript, scrub } from '../provider/replayFixture'
import * as ClaudeAdapter from './ClaudeAdapter'
import { makeFakeClaude } from './FakeClaude'
import { recordingSdk, replaySdk } from './replay'

/**
 * The real adapter against Agent SDK calls recorded from the real Claude Code
 * (scripts/record-claude-replay.ts). The replay SDK fails on any call the
 * recording did not make, so these also pin what the adapter asks Claude for.
 */

const fixture = (name: string) => new URL(`./fixtures/${name}.ndjson`, import.meta.url).pathname
const SETTINGS: TurnSettings = { model: null, effort: null, serviceTier: null, mode: null }
const WORKSPACE = '/tmp/replay-workspace'

/** A real folder for the scenario, so the adapter keeps it as the cwd, mapped back to the recorder's placeholder. */
const workspace = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), 'hidegpt-replay-test-')))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
).pipe(Effect.map((dir) => ({ dir, paths: [[dir, WORKSPACE]] as const })))

const open = (sdk: ClaudeAdapter.ClaudeSdk) =>
  Effect.gen(function* () {
    const session = yield* ClaudeAdapter.make(async () => sdk).openSession
    const events: AdapterEvent[] = []
    yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(Effect.forkScoped)
    return { session, events }
  })

/** The recorder's turn scenario: a new document, each prompt to the end of its turn, then its history. */
const turnScenario = (
  session: ProviderSession,
  events: ReadonlyArray<AdapterEvent>,
  prompts: ReadonlyArray<string>,
  cwd: string,
) =>
  Effect.gen(function* () {
    const created = yield* session.createThread({ cwd, projectId: null, title: null, settings: SETTINGS })
    for (const [index, text] of prompts.entries()) {
      const ended = () => events.filter((event) => event.type === 'turnEnded').length
      const before = ended()
      yield* session.send(
        created.threadId,
        { text, images: [], skill: null, clientId: `local-replay-${index + 1}` },
        SETTINGS,
      )
      yield* Effect.sleep('5 millis').pipe(
        Effect.repeat({ until: () => ended() > before }),
        Effect.timeout('5 seconds'),
      )
    }
    return yield* session.openThread(created.threadId)
  })

describe('ClaudeAdapter replay', () => {
  it.live('library: no login shows the sign-in hint, the list is empty, a missing document fails', () =>
    Effect.gen(function* () {
      const replay = replaySdk(readTranscript(fixture('library')))
      const { session } = yield* open(replay.sdk)

      const catalog = yield* Effect.flip(session.loadCatalog)
      expect(catalog._tag).toBe('NotLoggedInError')

      const docs = yield* Stream.runHead(session.listDocs(''))
      expect(docs._tag === 'Some' && docs.value).toEqual([])

      const missing = yield* Effect.flip(session.openThread('00000000-0000-4000-8000-000000000001'))
      expect(missing).toMatchObject({ _tag: 'ProviderRequestError', operation: 'getSessionInfo' })
      expect(replay.finished()).toEqual({ failure: null, unused: 0 })
    }),
  )

  const TURN_SKIP =
    'needs src/claude/fixtures/turn.ndjson, which a person records with real prompts (docs/replay-fixtures.md)'
  it.live.skipIf(!existsSync(fixture('turn')))(`turn: two real turns, then their history (${TURN_SKIP})`, () =>
    Effect.gen(function* () {
      const transcript = readTranscript(fixture('turn'))
      const prompts = transcript.metadata?.prompts as ReadonlyArray<string>
      const { dir, paths } = yield* workspace
      const replay = replaySdk(transcript, paths)
      const { session, events } = yield* open(replay.sdk)

      const opened = yield* turnScenario(session, events, prompts, dir)
      expect(events.filter((event) => event.type === 'turnEnded' && event.error)).toEqual([])
      expect(opened.blocks.flatMap((block) => (block.kind === 'user' ? [block.text] : []))).toEqual(prompts)
      expect(opened.blocks.filter((block) => block.kind === 'agent' && block.text)).toHaveLength(prompts.length)
      expect(replay.finished()).toEqual({ failure: null, unused: 0 })
    }),
  )

  // FakeClaude stands in for Claude Code, so this proves the turn path end to end before real turns are recorded.
  it.live('a turn recorded through recordingSdk replays to the same document', () =>
    Effect.gen(function* () {
      const prompts = ['First question', 'Second question']
      const entries: ReplayEntry[] = []
      const recording = yield* workspace
      const recorded = yield* Effect.scoped(
        Effect.gen(function* () {
          const { session, events } = yield* open(recordingSdk(makeFakeClaude().sdk, entries, true))
          return yield* turnScenario(session, events, prompts, recording.dir)
        }),
      )

      // Scrubbed as the recorder does, then replayed from another folder.
      const machine = { home: homedir(), people: [], hosts: [], scratch: recording.paths }
      const scrubbed = entries.map((entry) => scrub(entry, machine) as ReplayEntry)
      expect(JSON.stringify(scrubbed)).toContain(WORKSPACE)
      const replaying = yield* workspace
      const replay = replaySdk(
        {
          provider: 'claude',
          protocol: 'claude-agent-sdk.query',
          version: 'fake',
          scenario: 'turn',
          entries: scrubbed,
        },
        replaying.paths,
      )
      const replayed = yield* Effect.scoped(
        Effect.gen(function* () {
          const { session, events } = yield* open(replay.sdk)
          return yield* turnScenario(session, events, prompts, replaying.dir)
        }),
      )
      expect(replayed.blocks.map((block) => block.kind)).toEqual(recorded.blocks.map((block) => block.kind))
      expect(replayed.blocks.flatMap((block) => (block.kind === 'agent' ? [block.text] : []))).toEqual([
        'You asked: First question',
        'You asked: Second question',
      ])
      expect(replay.finished()).toEqual({ failure: null, unused: 0 })
    }),
  )

  it.live('without the turn gate, a prompt never reaches Claude Code', () =>
    Effect.gen(function* () {
      const fake = makeFakeClaude()
      const { session, events } = yield* open(recordingSdk(fake.sdk, [], false))
      const created = yield* session.createThread({ cwd: WORKSPACE, projectId: null, title: null, settings: SETTINGS })
      yield* session.send(created.threadId, { text: 'Hello', images: [], skill: null, clientId: 'local-1' }, SETTINGS)
      yield* Effect.sleep('5 millis').pipe(
        Effect.repeat({ until: () => events.some((event) => event.type === 'turnEnded') }),
        Effect.timeout('5 seconds'),
      )
      expect(fake.queries[0]?.prompts).toEqual([])
      expect(events.find((event) => event.type === 'turnEnded')).toMatchObject({
        error: expect.stringContaining('HIDEGPT_RECORD_TURNS=1'),
      })
    }),
  )

  it("folders are compared as the recorder's placeholders, not skipped", async () => {
    const recorded: ReplayTranscript = {
      provider: 'claude',
      protocol: 'claude-agent-sdk.query',
      version: 'synthetic',
      scenario: 'folders',
      entries: [
        { type: 'expect_outbound', frame: { call: 'listSessions', args: [{ dir: WORKSPACE }] } },
        { type: 'emit_inbound', frame: { call: 'listSessions', result: [] } },
        { type: 'expect_outbound', frame: { call: 'listSessions', args: [{ dir: '/home/replay-user/notes' }] } },
        { type: 'emit_inbound', frame: { call: 'listSessions', result: [] } },
      ],
    }
    const right = replaySdk(recorded, [['/somewhere/ws', WORKSPACE]])
    await right.sdk.listSessions({ dir: '/somewhere/ws' })
    await right.sdk.listSessions({ dir: join(homedir(), 'notes') })
    expect(right.finished()).toEqual({ failure: null, unused: 0 })

    const wrong = replaySdk(recorded, [['/somewhere/ws', WORKSPACE]])
    await expect(wrong.sdk.listSessions({ dir: '/somewhere/else' })).rejects.toThrow(/expected/)
  })

  describe('document ids', () => {
    const KNOWN = '11111111-1111-4111-8111-111111111111'
    const OTHER = '22222222-2222-4222-8222-222222222222'
    const MINTED = '33333333-3333-4333-8333-333333333333'
    const transcript = (entries: ReadonlyArray<ReplayEntry>): ReplayTranscript => ({
      provider: 'claude',
      protocol: 'claude-agent-sdk.query',
      version: 'synthetic',
      scenario: 'ids',
      entries,
    })
    const ask = (call: string, args: ReadonlyArray<unknown>, result: unknown): ReadonlyArray<ReplayEntry> => [
      { type: 'expect_outbound', frame: { call, args } },
      { type: 'emit_inbound', frame: { call, result } },
    ]

    it('a document Claude listed must be opened by that id, not another', async () => {
      const recorded = transcript([
        ...ask('listSessions', [{ limit: 500 }], [{ sessionId: KNOWN }]),
        ...ask('getSessionMessages', [KNOWN, {}], []),
      ])
      const right = replaySdk(recorded)
      await right.sdk.listSessions({ limit: 500 })
      await expect(right.sdk.getSessionMessages(KNOWN, {})).resolves.toEqual([])
      expect(right.finished()).toEqual({ failure: null, unused: 0 })

      const wrong = replaySdk(recorded)
      await wrong.sdk.listSessions({ limit: 500 })
      await expect(wrong.sdk.getSessionMessages(OTHER, {})).rejects.toThrow(/expected/)
    })

    it('a new document id binds once, and two recorded ids never share one', async () => {
      const recorded = transcript([
        ...ask('getSessionInfo', [KNOWN, {}], null),
        ...ask('getSessionInfo', [OTHER, {}], null),
      ])
      const replay = replaySdk(recorded)
      await replay.sdk.getSessionInfo(MINTED, {})
      await expect(replay.sdk.getSessionInfo(MINTED, {})).rejects.toThrow(/expected/)
    })
  })
})
