import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CanUseTool, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'

import type { AdapterEvent } from '../provider/ProviderAdapter'
import { readTranscript, type ReplayEntry, type ReplayTranscript, scrub } from '../provider/replayFixture'
import type { ReplayScenario, TurnResult } from '../provider/replayScenario'
import * as ClaudeAdapter from './ClaudeAdapter'
import { type FakeClaudeOptions, makeFakeClaude } from './FakeClaude'
import { recordingSdk, replaySdk } from './replay'
import { approval, library, stop, turn } from './replayScenarios'

/**
 * The real adapter against Agent SDK calls recorded from the real Claude Code
 * (scripts/record-claude-replay.ts). The replay SDK fails on any call the
 * recording did not make, so these also pin what the adapter asks Claude for.
 */

const fixture = (name: string) => new URL(`./fixtures/${name}.ndjson`, import.meta.url).pathname
const WORKSPACE = '/tmp/replay-workspace'

/** A real folder for the scenario, so the adapter keeps it as the cwd, mapped back to the recorder's placeholder. */
const workspace = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), 'hidegpt-replay-test-')))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
).pipe(Effect.map((dir) => ({ dir, paths: [[dir, WORKSPACE]] as const })))

/** Runs a scenario against `sdk` in its own scope, as the recorder does. */
const run = <A>(scenario: ReplayScenario<A>, sdk: ClaudeAdapter.ClaudeSdk, dir: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* ClaudeAdapter.make(async () => sdk).openSession
      const events: AdapterEvent[] = []
      yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(Effect.forkScoped)
      const result = yield* scenario.run({
        session,
        events,
        workspace: dir,
        wait: '5 seconds',
        afterCatalog: Effect.void,
      })
      return { result, events }
    }),
  )

const userTexts = (result: TurnResult) =>
  result.opened.blocks.flatMap((block) => (block.kind === 'user' ? [block.text] : []))

describe('ClaudeAdapter replay', () => {
  it.live('library: no login shows the sign-in hint, the list is empty, a missing document fails', () =>
    Effect.gen(function* () {
      const replay = replaySdk(readTranscript(fixture('library')))
      const { result } = yield* run(library, replay.sdk, WORKSPACE)

      expect(result.catalog._tag === 'Failure' && Cause.squash(result.catalog.cause)).toMatchObject({
        _tag: 'NotLoggedInError',
      })
      expect(result.docs._tag === 'Some' && result.docs.value).toEqual([])
      expect(result.missing._tag === 'Failure' && Cause.squash(result.missing.cause)).toMatchObject({
        _tag: 'ProviderRequestError',
        operation: 'getSessionInfo',
      })
      expect(replay.finished()).toEqual({ failure: null, unused: 0 })
    }),
  )

  /** Turn fixtures a person records with real prompts; each test is skipped until its file exists. */
  const recorded: ReadonlyArray<
    readonly [
      name: string,
      scenario: ReplayScenario<TurnResult>,
      check: (result: TurnResult, events: ReadonlyArray<AdapterEvent>) => void,
    ]
  > = [
    [
      'turn',
      turn,
      (result) => {
        expect(result.ended.filter((ended) => ended.error)).toEqual([])
        expect(userTexts(result)).toEqual(turn.prompts)
        expect(result.opened.blocks.filter((block) => block.kind === 'agent' && block.text)).toHaveLength(
          turn.prompts.length,
        )
      },
    ],
    [
      'stop',
      stop,
      (result) => {
        // A stopped turn ends without an error.
        expect(result.ended).toEqual([{ type: 'turnEnded', threadId: result.opened.threadId }])
        expect(userTexts(result)).toEqual(stop.prompts)
      },
    ],
    [
      'approval',
      approval,
      (result, events) => {
        expect(result.ended).toHaveLength(approval.prompts.length)
        expect(events.filter((event) => event.type === 'block' && event.block.kind === 'approval')).toHaveLength(
          approval.prompts.length,
        )
      },
    ],
  ]
  for (const [name, scenario, check] of recorded) {
    const skip = `needs src/claude/fixtures/${name}.ndjson, which a person records with real prompts (docs/replay-fixtures.md)`
    it.live.skipIf(!existsSync(fixture(name)))(`${name}: ${scenario.description} (${skip})`, () =>
      Effect.gen(function* () {
        const { dir, paths } = yield* workspace
        const replay = replaySdk(readTranscript(fixture(name)), paths)
        const { result, events } = yield* run(scenario, replay.sdk, dir)
        check(result, events)
        expect(replay.finished()).toEqual({ failure: null, unused: 0 })
      }),
    )
  }

  // FakeClaude stands in for Claude Code, so these prove each path end to end before real turns are recorded.
  const roundTrips: ReadonlyArray<readonly [ReplayScenario<TurnResult>, FakeClaudeOptions]> = [
    [turn, {}],
    // Slow enough that the stop lands mid-answer.
    [stop, { deltaDelayMs: 20 }],
  ]
  for (const [scenario, fakeOptions] of roundTrips) {
    const name = scenario === turn ? 'turn' : 'stop'
    it.live(`the ${name} scenario recorded through recordingSdk replays to the same document`, () =>
      Effect.gen(function* () {
        const entries: ReplayEntry[] = []
        const recording = yield* workspace
        const recorded = yield* run(
          scenario,
          recordingSdk(makeFakeClaude(fakeOptions).sdk, entries, true),
          recording.dir,
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
            scenario: name,
            entries: scrubbed,
          },
          replaying.paths,
        )
        const replayed = yield* run(scenario, replay.sdk, replaying.dir)

        const shape = (result: TurnResult) =>
          result.opened.blocks.map((block) => [block.kind, 'text' in block ? block.text : null])
        expect(shape(replayed.result)).toEqual(shape(recorded.result))
        expect(replayed.result.ended.map((ended) => ended.error ?? null)).toEqual(
          recorded.result.ended.map((ended) => ended.error ?? null),
        )
        expect(replay.finished()).toEqual({ failure: null, unused: 0 })
        if (scenario === turn) {
          expect(
            replayed.result.opened.blocks.flatMap((block) => (block.kind === 'agent' ? [block.text] : [])),
          ).toEqual(turn.prompts.map((prompt) => `You asked: ${prompt}`))
        } else {
          expect(entries.some((entry) => entry.type === 'expect_outbound' && entry.label === 'query.interrupt')).toBe(
            true,
          )
        }
      }),
    )
  }

  it.live('without the turn gate, a prompt never reaches Claude Code', () =>
    Effect.gen(function* () {
      const fake = makeFakeClaude()
      const { result } = yield* run(turn, recordingSdk(fake.sdk, [], false), WORKSPACE)
      expect(fake.queries.flatMap((query) => query.prompts)).toEqual([])
      expect(result.ended[0]?.error).toContain('HIDEGPT_RECORD_TURNS=1')
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

  it('permission requests are recorded and replayed: an accept, a deny, and a wrong answer fails', async () => {
    const WRITE = { file_path: 'tea.txt', content: 'tea' }
    const REMOVE = { command: 'rm tea.txt' }
    const decide =
      (allowAll: boolean): CanUseTool =>
      async (tool, input) =>
        allowAll || tool === 'Write'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Not this time.' }
    const silent = (async function* (): AsyncGenerator<SDKUserMessage> {})()

    // Record through the real wrapper: FakeClaude asks twice, as Claude Code would before two tools.
    const fake = makeFakeClaude()
    const entries: ReplayEntry[] = []
    const recordedQuery = recordingSdk(fake.sdk, entries, true).query({
      prompt: silent,
      options: { canUseTool: decide(false) },
    })
    await fake.queries[0]!.askTool('Write', WRITE, 'toolu_1').result
    await fake.queries[0]!.askTool('Bash', REMOVE, 'toolu_2').result
    recordedQuery.close()
    expect(entries.filter((entry) => entry.type !== 'runtime_exit' && entry.label?.startsWith('permission'))).toEqual([
      {
        type: 'emit_inbound',
        label: 'permission',
        frame: { query: 1, permission: { tool: 'Write', input: WRITE, toolUseID: 'toolu_1' } },
      },
      {
        type: 'expect_outbound',
        label: 'permissionResult',
        frame: { query: 1, permissionResult: { behavior: 'allow', updatedInput: WRITE } },
      },
      {
        type: 'emit_inbound',
        label: 'permission',
        frame: { query: 1, permission: { tool: 'Bash', input: REMOVE, toolUseID: 'toolu_2' } },
      },
      {
        type: 'expect_outbound',
        label: 'permissionResult',
        frame: { query: 1, permissionResult: { behavior: 'deny', message: 'Not this time.' } },
      },
    ])

    const transcript: ReplayTranscript = {
      provider: 'claude',
      protocol: 'claude-agent-sdk.query',
      version: 'fake',
      scenario: 'permissions',
      entries,
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

    // The same decisions replay cleanly: the replay itself calls Docs' canUseTool.
    const right = replaySdk(transcript)
    const asked: string[] = []
    const rightQuery = right.sdk.query({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {})(),
      options: {
        canUseTool: (tool, input, options) => (asked.push(options.toolUseID), decide(false)(tool, input, options)),
      },
    })
    await settle()
    rightQuery.close()
    expect(asked).toEqual(['toolu_1', 'toolu_2'])
    expect(right.finished()).toEqual({ failure: null, unused: 0 })

    // Allowing what the recording denied fails the replay.
    const wrong = replaySdk(transcript)
    wrong.sdk.query({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {})(),
      options: { canUseTool: decide(true) },
    })
    await settle()
    expect(wrong.finished().failure).toMatch(/expected .*"deny"/)
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
