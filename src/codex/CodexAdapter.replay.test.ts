import { existsSync, readdirSync } from 'node:fs'

import { version } from '../../package.json'

import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import type { AdapterEvent } from '../provider/ProviderAdapter'
import { readTranscript, type ReplayEntry, type ReplayTranscript } from '../provider/replayFixture'
import { type ReplayScenario, SETTINGS, type TurnResult } from '../provider/replayScenario'
import * as CodexClient from '../vendor/effect-codex-app-server/client.ts'
import * as CodexReplay from '../vendor/effect-codex-app-server/replay.ts'
import * as CodexAdapter from './CodexAdapter'
import { recordingOptions } from './replay'
import { approval, library, stop, turn } from './replayScenarios'

/**
 * The real adapter against frames recorded from the real `codex app-server`
 * (scripts/record-codex-replay.ts). The vendored replay client fails on any
 * frame the adapter sends that the recording did not, so these also pin the
 * adapter's wire traffic.
 */

const fixture = (name: string) => new URL(`./fixtures/${name}.ndjson`, import.meta.url).pathname

/**
 * A recording's `initialize` carries the app version it was recorded at. Swap in today's version so a
 * version bump doesn't fail every replay; the client name is still compared as recorded.
 */
const atCurrentVersion = (transcript: ReplayTranscript): ReplayTranscript => ({
  ...transcript,
  entries: transcript.entries.map((entry) => {
    if (entry.type !== 'expect_outbound' || entry.label !== 'initialize') return entry
    const frame = entry.frame as { params: { clientInfo: Record<string, unknown> } }
    return {
      ...entry,
      frame: { ...frame, params: { ...frame.params, clientInfo: { ...frame.params.clientInfo, version } } },
    }
  }),
})
const WORKSPACE = '/tmp/replay-workspace'

/** Opens a session over a recording; `finished` checks every recorded frame was used. */
const replay = (name: string, options: CodexClient.CodexAppServerClientOptions = {}) =>
  Effect.gen(function* () {
    const transcript = Schema.decodeUnknownSync(CodexReplay.CodexAppServerReplayTranscript)(
      atCurrentVersion(readTranscript(fixture(name))),
    )
    const driver = yield* CodexReplay.makeReplayDriver(transcript)
    const connect: CodexAdapter.Connect = Layer.build(CodexReplay.layerReplayWithDriver(driver, options)).pipe(
      Effect.orDie,
      Effect.map((context) => Context.get(context, CodexClient.CodexAppServerClient)),
    )
    const session = yield* CodexAdapter.make(connect).openSession
    const events: AdapterEvent[] = []
    yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(Effect.forkScoped)
    const finished = Ref.get(driver.state).pipe(
      Effect.map((state) => ({ failure: state.failure, unused: transcript.entries.length - state.cursor })),
    )
    return { session, events, transcript, driver, finished }
  })

/** The recorded `initialize` request. */
const initializeFrame = (transcript: CodexReplay.CodexAppServerReplayTranscript) =>
  transcript.entries.flatMap((entry) =>
    entry.type === 'expect_outbound' && entry.label === 'initialize' ? [entry.frame] : [],
  )[0]

const approvalIds = (events: ReadonlyArray<AdapterEvent>) =>
  new Set(
    events.flatMap((event) => (event.type === 'block' && event.block.kind === 'approval' ? [event.block.id] : [])),
  )
const userTexts = (result: TurnResult) =>
  result.opened.blocks.flatMap((block) => (block.kind === 'user' ? [block.text] : []))

/** Runs a scenario over a recording, as the recorder ran it against Codex. */
const runScenario = <A>(name: string, scenario: ReplayScenario<A>) =>
  Effect.gen(function* () {
    const { session, events, transcript, finished } = yield* replay(name)
    const result = yield* scenario.run({
      session,
      events,
      workspace: WORKSPACE,
      wait: '5 seconds',
      afterCatalog: Effect.void,
    })
    return { result, events, finished: yield* finished, initialize: initializeFrame(transcript) }
  })

describe('CodexAdapter replay', () => {
  it.effect('library: signed-out catalog, empty list, and a new document Codex cannot resume yet', () =>
    Effect.gen(function* () {
      const { result, events, finished, initialize } = yield* runScenario('library', library)

      // The replay client fails on a frame the recording does not hold, so this is also what was sent.
      // The version is today's (swapped in at load); the replay driver checks the sent frame matches it.
      expect(initialize).toMatchObject({ params: { clientInfo: { name: 'docs-desktop' } } })

      expect(result.catalog.account).toBeNull()
      expect(result.catalog.requiresAuth).toBe(true)
      expect(result.catalog.models.length).toBeGreaterThan(0)
      expect(result.catalog.modes.map((mode) => mode.id)).not.toContain('Plan')
      expect(result.docs._tag === 'Some' && result.docs.value).toEqual([])
      expect(result.created.cwd).toBe(WORKSPACE)
      expect(result.created.blocks).toEqual([])
      // Codex writes no transcript before the first turn; the adapter passes its error through.
      expect(result.resumed._tag === 'Failure' && Cause.squash(result.resumed.cause)).toMatchObject({
        _tag: 'ProviderRequestError',
        operation: 'thread/resume',
      })
      expect(finished).toEqual({ failure: null, unused: 0 })
      // The recording holds `remoteControl/status/changed`, which the protocol allowlist leaves
      // out: it arrives as an unknown notification and must not reach the page.
      expect(events.filter((event) => event.type === 'notice')).toEqual([])
    }),
  )

  /** Fixtures some test replays; the last test fails on a fixture that none does. */
  const wired = new Set(['library'])
  /** A fixture a person records with real prompts; its test is skipped until the file exists. */
  const recorded = <A extends TurnResult>(
    name: string,
    scenario: ReplayScenario<A>,
    check: (result: A, events: ReadonlyArray<AdapterEvent>) => void,
  ) => {
    wired.add(name)
    const present = existsSync(fixture(name))
    const skip = `needs src/codex/fixtures/${name}.ndjson, which a person records with real prompts (docs/replay-fixtures.md)`
    it.live.skipIf(!present)(
      present ? `${name}: ${scenario.description}` : `${name}: ${scenario.description} (${skip})`,
      () =>
        Effect.gen(function* () {
          const { result, events, finished } = yield* runScenario(name, scenario)
          check(result, events)
          expect(finished).toEqual({ failure: null, unused: 0 })
        }),
    )
  }
  recorded('turn', turn, (result, events) => {
    expect(result.ended.filter((ended) => ended.error)).toEqual([])
    expect(events.some((event) => event.type === 'text' && event.delta)).toBe(true)
    expect(userTexts(result)).toEqual(turn.prompts)
    expect(result.opened.blocks.filter((block) => block.kind === 'agent' && block.text)).toHaveLength(
      turn.prompts.length,
    )
  })
  recorded('stop', stop, (result) => {
    expect(result.ended).toHaveLength(1)
    expect(userTexts(result)).toEqual(stop.prompts)
  })
  // Codex may ask more than once in a turn; each turn has to ask at least once.
  recorded('approval', approval, (result, events) => {
    expect(result.ended).toHaveLength(approval.prompts.length)
    expect(result.asked).toHaveLength(approval.prompts.length)
    expect(result.asked.filter((count) => count < 1)).toEqual([])
    expect(approvalIds(events).size).toBe(result.asked.reduce((sum, count) => sum + count, 0))
  })

  it.effect('without the turn gate, the recorder stops turn/start before it reaches Codex', () =>
    Effect.gen(function* () {
      const entries: ReplayEntry[] = []
      const { session, transcript, driver } = yield* replay('library', recordingOptions(entries, false))
      yield* session.loadCatalog
      yield* Stream.runHead(session.listDocs(''))
      const created = yield* session.createThread({ cwd: WORKSPACE, projectId: null, title: null, settings: SETTINGS })

      // The thread is loaded, so a send goes straight to turn/start.
      const sent = yield* Effect.exit(
        session.send(created.threadId, { text: 'Hi', images: [], skill: null, clientId: 'local-1' }, SETTINGS),
      )
      expect(sent._tag).toBe('Failure')
      expect(String(sent._tag === 'Failure' && sent.cause)).toContain('HIDEGPT_RECORD_TURNS=1')

      // Codex (the replay driver) saw nothing after thread/start: no mismatch, still waiting on the next recorded frame.
      const state = yield* Ref.get(driver.state)
      expect(state.failure).toBeNull()
      expect(transcript.entries[state.cursor]).toMatchObject({ type: 'expect_outbound', label: 'thread/resume' })
      expect(entries.map((entry) => ('label' in entry ? entry.label : null))).not.toContain('turn/start')
      expect(entries.at(-1)).toMatchObject({ type: 'emit_inbound', label: 'thread/start' })
    }),
  )

  // Like T3's ProviderReplayFixtures: a recorded fixture that no test replays would pass unseen.
  it('replays every fixture in the folder', () => {
    const names = readdirSync(new URL('./fixtures/', import.meta.url))
      .filter((file) => file.endsWith('.ndjson'))
      .map((file) => file.slice(0, -'.ndjson'.length))
    expect(names.filter((name) => !wired.has(name))).toEqual([])
  })
})
