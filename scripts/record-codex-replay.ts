// Adapted from T3 Code (https://github.com/pingdotgg/t3code), apps/server/scripts/record-codex-app-server-replay-fixture.ts
// at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
/**
 * Records a Codex replay fixture: runs HideGPT's real Codex adapter against the
 * installed `codex app-server` and writes every JSON-RPC frame, scrubbed, to
 * `src/codex/fixtures/<scenario>.ndjson`. See docs/replay-fixtures.md.
 *
 *   pnpm record:codex library            # no prompt; any agent may run it
 *   HIDEGPT_RECORD_TURNS=1 pnpm record:codex turn   # a person only: sends 2 prompts
 *
 * Without HIDEGPT_RECORD_TURNS=1 only `NO_PROMPT_METHODS` (src/codex/replay.ts)
 * can reach Codex, so the recorder cannot start a turn even by mistake.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import * as CodexAdapter from '../src/codex/CodexAdapter.ts'
import { recordingOptions } from '../src/codex/replay.ts'
import type { AdapterEvent, ProviderSession, TurnSettings } from '../src/provider/ProviderAdapter.ts'
import {
  encodeTranscript,
  leaks,
  type ReplayEntry,
  scrub,
  thisMachine,
  TurnRefusedError,
  turnsAllowed,
} from '../src/provider/replayFixture.ts'
import * as CodexClient from '../src/vendor/effect-codex-app-server/client.ts'

const SETTINGS: TurnSettings = { model: null, effort: null, serviceTier: null, mode: null }
/** Fixed and harmless; the fixture's metadata keeps them so the replay test sends the same ones. */
const TURN_PROMPTS = ['Reply with one short sentence about tea.', 'Now say it again in five words or fewer.']

type Scenario = {
  readonly description: string
  readonly sendsTurns: boolean
  readonly run: (
    session: ProviderSession,
    events: ReadonlyArray<AdapterEvent>,
    workspace: string,
  ) => Effect.Effect<void, unknown>
}

const SCENARIOS: Record<string, Scenario> = {
  library: {
    description:
      'Handshake, catalog and document list, signed out; then a new document, which Codex cannot resume before its first turn. No prompt.',
    sendsTurns: false,
    run: (session, _events, workspace) =>
      Effect.gen(function* () {
        yield* session.loadCatalog
        yield* Stream.runHead(session.listDocs(''))
        const created = yield* session.createThread({
          cwd: workspace,
          projectId: null,
          title: null,
          settings: SETTINGS,
        })
        // Codex keeps no transcript until the first turn, so this records its real "no rollout" error.
        yield* Effect.exit(session.openThread(created.threadId))
        yield* session.releaseThread(created.threadId)
      }),
  },
  turn: {
    description: 'A new document, two short turns, then the document opened again to read its history.',
    sendsTurns: true,
    run: (session, events, workspace) =>
      Effect.gen(function* () {
        const created = yield* session.createThread({
          cwd: workspace,
          projectId: null,
          title: null,
          settings: SETTINGS,
        })
        for (const [index, text] of TURN_PROMPTS.entries()) {
          const ended = () => events.filter((event) => event.type === 'turnEnded').length
          const before = ended()
          yield* session.send(
            created.threadId,
            { text, images: [], skill: null, clientId: `local-replay-${index + 1}` },
            SETTINGS,
          )
          yield* Effect.sleep('200 millis').pipe(
            Effect.repeat({ until: () => ended() > before }),
            Effect.timeout('3 minutes'),
          )
        }
        yield* session.openThread(created.threadId)
        yield* session.releaseThread(created.threadId)
      }),
  },
}

/** The adapter's `Connect`, over `codex app-server` with every decoded frame recorded (and turns refused). */
const recordingConnect = (
  spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
  env: Record<string, string>,
  cwd: string,
  entries: ReplayEntry[],
  allowTurns: boolean,
): CodexAdapter.Connect =>
  Effect.gen(function* () {
    const handle = yield* spawner
      .spawn(ChildProcess.make(env.CODEX_BIN || 'codex', ['app-server'], { cwd, env, extendEnv: false }))
      .pipe(Effect.orDie)
    const context = yield* Layer.build(CodexClient.layerChildProcess(handle, recordingOptions(entries, allowTurns)))
    return Context.get(context, CodexClient.CodexAppServerClient)
  })

function versionOf(entries: ReadonlyArray<ReplayEntry>): string {
  for (const entry of entries) {
    if (entry.type !== 'emit_inbound' || entry.label !== 'initialize') continue
    const agent = (entry.frame as { result?: { userAgent?: unknown } }).result?.userAgent
    const match = typeof agent === 'string' ? /\/([0-9][^\s)]*)/.exec(agent) : null
    if (match?.[1]) return match[1]
  }
  return 'unknown'
}

async function main() {
  const name = process.argv[2] ?? 'library'
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`Unknown scenario "${name}". Choose one of: ${Object.keys(SCENARIOS).join(', ')}.`)
  const allowTurns = turnsAllowed()
  if (scenario.sendsTurns && !allowTurns) throw new TurnRefusedError(`record the "${name}" scenario`)

  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'hidegpt-replay-workspace-')))
  const codexHome = realpathSync(mkdtempSync(join(tmpdir(), 'hidegpt-replay-codex-')))
  const { OPENAI_API_KEY: _openai, CODEX_API_KEY: _codex, ...inherited } = process.env
  // No-prompt runs get an empty Codex home: signed out, with none of the person's documents.
  // Turn runs keep the person's own Codex login, which Codex reads itself.
  const env = Object.fromEntries(
    Object.entries(scenario.sendsTurns ? process.env : { ...inherited, CODEX_HOME: codexHome }).filter(
      (pair): pair is [string, string] => pair[1] !== undefined,
    ),
  )
  const machine = thisMachine([
    [codexHome, '/tmp/replay-codex-home'],
    [workspace, '/tmp/replay-workspace'],
  ])

  const entries: ReplayEntry[] = []
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const session = yield* CodexAdapter.make(recordingConnect(spawner, env, workspace, entries, allowTurns))
          .openSession
        const events: AdapterEvent[] = []
        yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(
          Effect.forkScoped,
        )
        yield* scenario.run(session, events, workspace)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    )
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(codexHome, { recursive: true, force: true })
  }

  const text = encodeTranscript({
    provider: 'codex',
    protocol: 'codex.app-server',
    version: versionOf(entries),
    scenario: name,
    metadata: {
      source: 'scripts/record-codex-replay.ts',
      description: scenario.description,
      ...(scenario.sendsTurns ? { prompts: TURN_PROMPTS } : {}),
    },
    entries: [
      ...entries.map((entry) => scrub(entry, machine) as ReplayEntry),
      { type: 'runtime_exit', status: 'success' },
    ],
  })
  const found = leaks(text, machine)
  if (found.length)
    throw new Error(`Scrubbing missed ${found.length} value(s); nothing was written. First: ${found[0]}`)
  const out = new URL(`../src/codex/fixtures/${name}.ndjson`, import.meta.url)
  writeFileSync(out, text)
  console.log(`Wrote ${entries.length} frames to ${out.pathname.replace(process.cwd() + '/', '')}`)
}

await main()
