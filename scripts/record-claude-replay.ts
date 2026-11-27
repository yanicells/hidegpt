// Adapted from T3 Code (https://github.com/pingdotgg/t3code), apps/server/scripts/record-claude-agent-sdk-replay-fixture.ts
// at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
/**
 * Records a Claude replay fixture: runs HideGPT's real Claude adapter over the
 * real Agent SDK, wrapped by `recordingSdk`, and writes every call, answer and
 * message, scrubbed, to `src/claude/fixtures/<scenario>.ndjson`. See
 * docs/replay-fixtures.md.
 *
 *   pnpm record:claude library            # no prompt, no login; any agent may run it
 *   HIDEGPT_RECORD_TURNS=1 pnpm record:claude turn|stop|approval   # a person only: sends prompts
 *
 * The scenarios themselves live in src/claude/replayScenarios.ts, shared with the replay tests.
 *
 * The no-prompt run points Claude Code at an empty home and config folder with
 * every auth variable removed, so neither this script nor Claude Code can find
 * a login, and the person's own sessions stay out of the fixture.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'

import * as ClaudeAdapter from '../src/claude/ClaudeAdapter.ts'
import { recordingSdk } from '../src/claude/replay.ts'
import { SCENARIOS } from '../src/claude/replayScenarios.ts'
import type { AdapterEvent } from '../src/provider/ProviderAdapter.ts'
import {
  encodeTranscript,
  leaks,
  REPLAY_HOME,
  type ReplayEntry,
  scrub,
  thisMachine,
  TurnRefusedError,
  turnsAllowed,
} from '../src/provider/replayFixture.ts'

/** Variables that would hand Claude Code a login without its config folder. */
const AUTH_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]

/** `account.tokenSource` from the recorded probe answer, or "missing" when there is none. */
function tokenSource(entries: ReadonlyArray<ReplayEntry>): string {
  const answer = entries.find((entry) => entry.type === 'emit_inbound' && entry.label === 'query.initializationResult')
  const frame =
    answer?.type === 'emit_inbound' ? (answer.frame as { result?: { account?: { tokenSource?: unknown } } }) : undefined
  const source = frame?.result?.account?.tokenSource
  return typeof source === 'string' ? source : 'missing'
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
  return {
    ...entry,
    frame: { ...frame, message: { ...frame.message, ...Object.fromEntries(lists.map((key) => [key, []])) } },
  }
}

function versionOf(entries: ReadonlyArray<ReplayEntry>): string {
  for (const entry of entries) {
    if (entry.type !== 'emit_inbound') continue
    const message = (entry.frame as { message?: { type?: string; claude_code_version?: unknown } } | undefined)?.message
    if (message?.type === 'system' && typeof message.claude_code_version === 'string')
      return message.claude_code_version
  }
  // A probe streams no messages; the SDK's own version is the next best thing.
  const sdk = new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url)
  return `agent-sdk ${(JSON.parse(readFileSync(sdk, 'utf8')) as { version: string }).version}`
}

async function main() {
  const name = process.argv[2] ?? 'library'
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`Unknown scenario "${name}". Choose one of: ${Object.keys(SCENARIOS).join(', ')}.`)
  const sendsTurns = scenario.prompts.length > 0
  const allowTurns = turnsAllowed()
  if (sendsTurns && !allowTurns) throw new TurnRefusedError(`record the "${name}" scenario`)

  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'hidegpt-replay-workspace-')))
  const emptyHome = realpathSync(mkdtempSync(join(tmpdir(), 'hidegpt-replay-claude-')))
  const machine = thisMachine([
    [workspace, '/tmp/replay-workspace'],
    // The replay maps its own home folder to the same placeholder.
    [emptyHome, REPLAY_HOME],
  ])
  if (!sendsTurns) {
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
        yield* Stream.runForEach(session.events, (event) => Effect.sync(() => events.push(event))).pipe(
          Effect.forkScoped,
        )
        yield* scenario.run({
          session,
          events,
          workspace,
          wait: '3 minutes',
          // Judged on Claude Code's own answer, not Docs' reading of it: any login source at all in the
          // empty home means it found credentials after all, so stop before anything personal is written.
          afterCatalog: Effect.suspend(() => {
            const source = tokenSource(entries)
            return sendsTurns || source === 'none'
              ? Effect.void
              : Effect.die(
                  new Error(`Claude Code reported token source "${source}" in the empty home; nothing was written.`),
                )
          }),
        })
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
      ...(sendsTurns ? { prompts: scenario.prompts } : {}),
    },
    entries: [
      ...entries.map((entry) => scrub(withoutPersonalLists(entry), machine) as ReplayEntry),
      { type: 'runtime_exit', status: 'success' },
    ],
  })
  const found = leaks(text, machine)
  if (found.length)
    throw new Error(`Scrubbing missed ${found.length} value(s); nothing was written. First: ${found[0]}`)
  const out = new URL(`../src/claude/fixtures/${name}.ndjson`, import.meta.url)
  writeFileSync(out, text)
  console.log(`Wrote ${entries.length} entries to ${out.pathname.replace(process.cwd() + '/', '')}`)
}

await main()
