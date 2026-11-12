// Adapted from T3 Code (https://github.com/pingdotgg/t3code), apps/server/scripts/record-claude-agent-sdk-replay-fixture.ts
// at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
/**
 * Records a Claude replay fixture: runs HideGPT's real Claude adapter over the
 * real Agent SDK, wrapped by `recordingSdk`, and writes every call, answer and
 * message, scrubbed, to `src/claude/fixtures/<scenario>.ndjson`. See
 * docs/replay-fixtures.md.
 *
 *   pnpm record:claude library            # no prompt, no login; any agent may run it
 *   HIDEGPT_RECORD_TURNS=1 pnpm record:claude turn   # a person only: sends 2 prompts
 *
 * The no-prompt run points Claude Code at an empty home and config folder with
 * every auth variable removed, so neither this script nor Claude Code can find
 * a login, and the person's own sessions stay out of the fixture.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'

import * as ClaudeAdapter from '../src/claude/ClaudeAdapter.ts'
import { recordingSdk } from '../src/claude/replay.ts'
import type { AdapterEvent, ProviderSession, TurnSettings } from '../src/provider/ProviderAdapter.ts'
import {
  encodeTranscript,
  leaks,
  type RecordingMachine,
  type ReplayEntry,
  scrub,
  TurnRefusedError,
  turnsAllowed,
} from '../src/provider/replayFixture.ts'

const SETTINGS: TurnSettings = { model: null, effort: null, serviceTier: null, mode: null }
/** Fixed and harmless; the fixture's metadata keeps them so the replay test sends the same ones. */
const TURN_PROMPTS = ['Reply with one short sentence about tea.', 'Now say it again in five words or fewer.']
/** No such session exists; opening it records Claude's "not found" path. */
const MISSING_SESSION = '00000000-0000-4000-8000-000000000001'
/** Variables that would hand Claude Code a login without its config folder. */
const AUTH_VARIABLES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']

type Scenario = {
  readonly description: string
  readonly sendsTurns: boolean
  readonly run: (session: ProviderSession, events: ReadonlyArray<AdapterEvent>, workspace: string) => Effect.Effect<void, unknown>
}

const SCENARIOS: Record<string, Scenario> = {
  library: {
    description: 'Catalog probe with no login (Docs shows the sign-in hint), an empty document list, and a document that does not exist. No prompt.',
    sendsTurns: false,
    run: (session) =>
      Effect.gen(function* () {
        const catalog = yield* Effect.exit(session.loadCatalog)
        // Claude Code found a login after all: stop before anything personal is written.
        if (catalog._tag === 'Success') return yield* Effect.die(new Error('Claude Code reported a login in the empty home; nothing was written.'))
        yield* Stream.runHead(session.listDocs(''))
        yield* Effect.exit(session.openThread(MISSING_SESSION))
      }),
  },
  turn: {
    description: 'A new document, two short turns, then the document opened again to read its history.',
    sendsTurns: true,
    run: (session, events, workspace) =>
      Effect.gen(function* () {
        const created = yield* session.createThread({ cwd: workspace, projectId: null, title: null, settings: SETTINGS })
        for (const [index, text] of TURN_PROMPTS.entries()) {
          const ended = () => events.filter((event) => event.type === 'turnEnded').length
          const before = ended()
          yield* session.send(created.threadId, { text, images: [], skill: null, clientId: `local-replay-${index + 1}` }, SETTINGS)
          yield* Effect.sleep('200 millis').pipe(Effect.repeat({ until: () => ended() > before }), Effect.timeout('3 minutes'))
        }
        yield* session.openThread(created.threadId)
      }),
  },
}

/**
 * Claude Code's start-up message lists the person's MCP servers, skills, plugins
 * and agents. Docs reads none of them, so the fixture keeps the shape and drops the names.
 */
function withoutPersonalLists(entry: ReplayEntry): ReplayEntry {
  if (entry.type !== 'emit_inbound') return entry
  const frame = entry.frame as { message?: Record<string, unknown> }
  if (frame.message?.type !== 'system' || frame.message.subtype !== 'init') return entry
  const lists = ['mcp_servers', 'slash_commands', 'skills', 'plugins', 'agents', 'tools']
  return { ...entry, frame: { ...frame, message: { ...frame.message, ...Object.fromEntries(lists.map((key) => [key, []])) } } }
}

function versionOf(entries: ReadonlyArray<ReplayEntry>): string {
  for (const entry of entries) {
    if (entry.type !== 'emit_inbound') continue
    const message = (entry.frame as { message?: { type?: string; claude_code_version?: unknown } } | undefined)?.message
    if (message?.type === 'system' && typeof message.claude_code_version === 'string') return message.claude_code_version
  }
  // A probe streams no messages; the SDK's own version is the next best thing.
  const sdk = new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url)
  return `agent-sdk ${(JSON.parse(readFileSync(sdk, 'utf8')) as { version: string }).version}`
}

async function main() {
  const name = process.argv[2] ?? 'library'
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`Unknown scenario "${name}". Choose one of: ${Object.keys(SCENARIOS).join(', ')}.`)
  const allowTurns = turnsAllowed()
  if (scenario.sendsTurns && !allowTurns) throw new TurnRefusedError(`record the "${name}" scenario`)

  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'hidegpt-replay-workspace-')))
  const emptyHome = realpathSync(mkdtempSync(join(tmpdir(), 'hidegpt-replay-claude-')))
  const machine: RecordingMachine = {
    home: process.env.HOME ?? '',
    username: userInfo().username,
    hostname: hostname(),
    scratch: [
      [workspace, '/tmp/replay-workspace'],
      [emptyHome, '/tmp/replay-home'],
    ],
  }
  if (!scenario.sendsTurns) {
    // Set before the SDK loads: it and the Claude Code it starts read these, and the
    // SDK's session list reads the home folder in this process.
    mkdirSync(join(emptyHome, '.claude'))
    for (const variable of AUTH_VARIABLES) delete process.env[variable]
    Object.assign(process.env, {
      HOME: emptyHome,
      CLAUDE_CONFIG_DIR: join(emptyHome, '.claude'),
      USER: 'replay-user',
      LOGNAME: 'replay-user',
    })
  }

  const entries: ReplayEntry[] = []
  try {
    const sdk = recordingSdk(await import('@anthropic-ai/claude-agent-sdk'), entries, allowTurns)
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* ClaudeAdapter.make(async () => sdk).openSession
        const events: AdapterEvent[] = []
        yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(Effect.forkScoped)
        yield* scenario.run(session, events, workspace)
      }).pipe(Effect.scoped),
    )
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(emptyHome, { recursive: true, force: true })
  }

  const text = encodeTranscript({
    provider: 'claude',
    protocol: 'claude-agent-sdk.query',
    version: versionOf(entries),
    scenario: name,
    metadata: {
      source: 'scripts/record-claude-replay.ts',
      description: scenario.description,
      ...(scenario.sendsTurns ? { prompts: TURN_PROMPTS } : {}),
    },
    entries: [
      ...entries.map((entry) => scrub(withoutPersonalLists(entry), machine) as ReplayEntry),
      { type: 'runtime_exit', status: 'success' },
    ],
  })
  const found = leaks(text, machine)
  if (found.length) throw new Error(`Scrubbing missed ${found.length} value(s); nothing was written. First: ${found[0]}`)
  const out = new URL(`../src/claude/fixtures/${name}.ndjson`, import.meta.url)
  writeFileSync(out, text)
  console.log(`Wrote ${entries.length} entries to ${out.pathname.replace(process.cwd() + '/', '')}`)
}

await main()
