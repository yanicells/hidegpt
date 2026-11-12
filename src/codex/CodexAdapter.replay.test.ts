import { existsSync } from 'node:fs'

import { describe, expect, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import type { AdapterEvent, TurnSettings } from '../provider/ProviderAdapter'
import { readTranscript, type ReplayEntry } from '../provider/replayFixture'
import * as CodexClient from '../vendor/effect-codex-app-server/client.ts'
import * as CodexReplay from '../vendor/effect-codex-app-server/replay.ts'
import * as CodexAdapter from './CodexAdapter'
import { recordingOptions } from './replay'

/**
 * The real adapter against frames recorded from the real `codex app-server`
 * (scripts/record-codex-replay.ts). The vendored replay client fails on any
 * frame the adapter sends that the recording did not, so these also pin the
 * adapter's wire traffic.
 */

const fixture = (name: string) => new URL(`./fixtures/${name}.ndjson`, import.meta.url).pathname
const SETTINGS: TurnSettings = { model: null, effort: null, serviceTier: null, mode: null }
const WORKSPACE = '/tmp/replay-workspace'

/** Opens a session over a recording; `finished` checks every recorded frame was used. */
const replay = (name: string) =>
  Effect.gen(function* () {
    const transcript = Schema.decodeUnknownSync(CodexReplay.CodexAppServerReplayTranscript)(readTranscript(fixture(name)))
    const driver = yield* CodexReplay.makeReplayDriver(transcript)
    const connect: CodexAdapter.Connect = Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
      Effect.orDie,
      Effect.map((context) => Context.get(context, CodexClient.CodexAppServerClient)),
    )
    const session = yield* CodexAdapter.make(connect).openSession
    const events: AdapterEvent[] = []
    yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(Effect.forkScoped)
    const finished = Ref.get(driver.state).pipe(
      Effect.map((state) => ({ failure: state.failure, unused: transcript.entries.length - state.cursor })),
    )
    return { session, events, transcript, finished }
  })

describe('CodexAdapter replay', () => {
  it.effect('library: signed-out catalog, empty list, and a new document Codex cannot resume yet', () =>
    Effect.gen(function* () {
      const { session, finished } = yield* replay('library')

      const catalog = yield* session.loadCatalog
      expect(catalog.account).toBeNull()
      expect(catalog.requiresAuth).toBe(true)
      expect(catalog.models.length).toBeGreaterThan(0)
      expect(catalog.modes.map((mode) => mode.id)).not.toContain('Plan')

      const docs = yield* Stream.runHead(session.listDocs(''))
      expect(docs._tag === 'Some' && docs.value).toEqual([])

      const created = yield* session.createThread({ cwd: WORKSPACE, projectId: null, title: null, settings: SETTINGS })
      expect(created.cwd).toBe(WORKSPACE)
      expect(created.blocks).toEqual([])

      // Codex writes no transcript before the first turn; the adapter passes its error through.
      const error = yield* Effect.flip(session.openThread(created.threadId))
      expect(error).toMatchObject({ _tag: 'ProviderRequestError', operation: 'thread/resume' })
      expect(error.message).toBeTruthy()

      yield* session.releaseThread(created.threadId)
      expect(yield* finished).toEqual({ failure: null, unused: 0 })
    }),
  )

  const TURN_SKIP = 'needs src/codex/fixtures/turn.ndjson, which a person records with real prompts (docs/replay-fixtures.md)'
  it.live.skipIf(!existsSync(fixture('turn')))(`turn: two real turns, then their history (${TURN_SKIP})`, () =>
    Effect.gen(function* () {
      const { session, events, transcript, finished } = yield* replay('turn')
      const prompts = transcript.metadata?.prompts as ReadonlyArray<string>

      const created = yield* session.createThread({ cwd: WORKSPACE, projectId: null, title: null, settings: SETTINGS })
      for (const [index, text] of prompts.entries()) {
        const ended = () => events.filter((event) => event.type === 'turnEnded').length
        const before = ended()
        yield* session.send(created.threadId, { text, images: [], skill: null, clientId: `local-replay-${index + 1}` }, SETTINGS)
        yield* Effect.sleep('5 millis').pipe(Effect.repeat({ until: () => ended() > before }), Effect.timeout('5 seconds'))
      }
      expect(events.filter((event) => event.type === 'turnEnded' && event.error)).toEqual([])
      expect(events.some((event) => event.type === 'text' && event.delta)).toBe(true)

      const opened = yield* session.openThread(created.threadId)
      const users = opened.blocks.flatMap((block) => (block.kind === 'user' ? [block.text] : []))
      const answers = opened.blocks.filter((block) => block.kind === 'agent' && block.text)
      expect(users).toEqual(prompts)
      expect(answers).toHaveLength(prompts.length)

      yield* session.releaseThread(created.threadId)
      expect(yield* finished).toEqual({ failure: null, unused: 0 })
    }),
  )

  it.effect('without the turn gate, the recorder dies before turn/start is written, and records the rest', () =>
    Effect.gen(function* () {
      const entries: ReplayEntry[] = []
      const log = recordingOptions(entries, false).logger!
      yield* log({ direction: 'outgoing', stage: 'decoded', payload: { id: 1, method: 'thread/list', params: {} } })
      yield* log({ direction: 'incoming', stage: 'decoded', payload: { id: 1, result: { data: [] } } })
      const refused = yield* Effect.exit(log({ direction: 'outgoing', stage: 'decoded', payload: { id: 2, method: 'turn/start', params: {} } }))
      expect(refused._tag).toBe('Failure')
      expect(entries.map((entry) => [entry.type, 'label' in entry ? entry.label : null])).toEqual([
        ['expect_outbound', 'thread/list'],
        ['emit_inbound', 'thread/list'],
      ])
    }),
  )
})
