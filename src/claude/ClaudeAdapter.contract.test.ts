import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import * as Effect from 'effect/Effect'

import {
  contractSuite,
  notScripted,
  settle,
  tick,
  until,
  type ContractDriver,
  type Received,
} from '../provider/contract.testkit'
import { fromLegacy } from '../provider/legacyEvents'
import * as ClaudeAdapter from './ClaudeAdapter'
import { assistantFrame, makeFakeClaude, resultFrame, streamEvent } from './FakeClaude'

/**
 * The adapter contract (src/provider/contract.testkit.ts) against Claude, over the in-process
 * Agent SDK. The driver pushes the frames Claude Code writes into the document's live query and
 * answers `canUseTool`. Claude Code answers an interrupt with an aborted `result` whenever a turn
 * is running, so the driver's query does too (the fake only does it for answers it streams itself).
 */

/** A frame typed loosely, as the fake's own builders are. */
const frame = (message: Record<string, unknown>) => message as unknown as SDKMessage

/** A message Claude Code writes itself: an assistant frame from the model `<synthetic>`. */
const cliNotice = (text: string, error?: string) =>
  frame({
    ...(assistantFrame('msg_notice', [{ type: 'text', text }]) as unknown as Record<string, unknown>),
    message: { id: 'msg_notice', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
    ...(error ? { error } : {}),
  })

const driver: ContractDriver = {
  provider: 'claude',
  settings: { model: 'default', effort: 'high', serviceTier: null, mode: null },
  notScripted: {
    subagent_outlives_stop: 'subagents run inside the query, and the fake has no background tasks',
  },
  open: Effect.gen(function* () {
    const fake = makeFakeClaude({ reply: null })
    const received: Received[] = []
    /** Turns Claude Code is running: prompts read plus turns it started itself, less results written. */
    let selfStarted = 0
    let results = 0
    let hold: { reached: () => void; release: Promise<void> } | null = null
    const live = () => fake.queries.at(-1)
    const running = () => (live()?.prompts.length ?? 0) + selfStarted - results

    const sdk: ClaudeAdapter.ClaudeSdk = {
      ...fake.sdk,
      // A new document's first send asks whether a transcript exists before Claude Code starts.
      getSessionInfo: async (...args) => {
        const held = hold
        hold = null
        if (held) {
          held.reached()
          await held.release
        }
        return fake.sdk.getSessionInfo(...args)
      },
      query: (params) => {
        const query = fake.sdk.query(params)
        const record = fake.queries.at(-1)!
        const interrupt = query.interrupt.bind(query)
        query.interrupt = async () => {
          received.push({ op: 'interrupt', target: null })
          const response = await interrupt()
          await new Promise((resolve) => setImmediate(resolve))
          if (running() > 0) {
            results += 1
            record.push(
              resultFrame({
                subtype: 'error_during_execution',
                is_error: true,
                errors: ['Request was aborted.'],
                terminal_reason: 'aborted_streaming',
              }),
            )
          }
          return response
        }
        return query
      },
    }
    const session = yield* fromLegacy(ClaudeAdapter.make(() => Promise.resolve(sdk))).openSession
    const opened = yield* session.createThread({
      cwd: '/tmp',
      projectId: null,
      title: 'Reading notes',
      settings: driver.settings,
    })

    /** Frames go to the document's query once the adapter started it. */
    const push = (...frames: ReadonlyArray<SDKMessage>) =>
      Effect.gen(function* () {
        yield* until(() => live() !== undefined, 'Claude Code started')
        for (const message of frames) live()!.push(message)
      })
    const stream = (text: string) =>
      push(
        streamEvent({ type: 'message_start', message: { id: `msg_${results}` } }),
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        ...(text.match(/\S+\s*/g) ?? []).map((word) =>
          streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } }),
        ),
        assistantFrame(`msg_${results}`, [{ type: 'text', text }]),
      )
    const result = (fields: Record<string, unknown> = {}) =>
      Effect.suspend(() => {
        results += 1
        return push(resultFrame(fields))
      })
    /** Asks before a tool runs; the decision is recorded once Claude Code gets it. */
    const ask = (...args: Parameters<NonNullable<ReturnType<typeof live>>['askTool']>) =>
      Effect.gen(function* () {
        yield* until(() => live() !== undefined, 'Claude Code started')
        void live()!
          .askTool(...args)
          .result.then((decision) => {
            if (decision) received.push({ op: decision.behavior === 'allow' ? 'approve' : 'decline' })
          })
      })

    return {
      session,
      opened,
      script: {
        answer: (text) => Effect.andThen(stream(text), result({ result: text })),
        holdStart: Effect.sync(() => {
          let reached = () => {}
          let release = () => {}
          const gate = {
            reached: new Promise<void>((resolve) => (reached = resolve)),
            release: new Promise<void>((resolve) => (release = resolve)),
          }
          hold = { reached, release: gate.release }
          return { reached: Effect.promise(() => gate.reached), release: Effect.sync(release) }
        }),
        askFor: ask('Bash', { command: 'rm -r build' }, 'toolu_ask'),
        fail: (kind) =>
          kind === 'usage_limit'
            ? Effect.andThen(
                push(cliNotice("You've hit your session limit · resets 3pm", 'rate_limit')),
                result({ is_error: true, result: "You've hit your session limit · resets 3pm", api_error_status: 429 }),
              )
            : Effect.andThen(
                push(cliNotice('API Error: 529 Overloaded', 'server_error')),
                result({ is_error: true, result: 'API Error: 529 Overloaded', api_error_status: 529 }),
              ),
        exit: Effect.andThen(
          until(() => live() !== undefined, 'Claude Code started'),
          Effect.sync(() => live()!.exit(new Error('Claude Code process exited with code 1'))),
        ),
        // A finished background task's bookkeeping result: it ends no turn.
        foreignTerminal: push(resultFrame({ origin: { kind: 'task-notification' }, num_turns: 0 })),
        selfStart: (text) =>
          Effect.suspend(() => {
            selfStarted += 1
            return stream(text)
          }),
        notice: (text) => push(cliNotice(text)),
        passthrough: (marker) =>
          Effect.gen(function* () {
            yield* push(
              assistantFrame('msg_tools', [
                { type: 'tool_use', id: 'toolu_m', name: `mcp__${marker}_server__${marker}_search`, input: {} },
                { type: 'tool_use', id: 'toolu_t', name: `${marker}Tool`, input: {} },
              ]),
            )
            yield* ask(`${marker}Tool`, { command: 'ls' }, 'toolu_t', {
              title: `${marker} title`,
              displayName: `${marker} name`,
              description: `${marker} description`,
              decisionReason: `${marker} reason`,
            })
            yield* push(
              cliNotice(`${marker} notice`),
              frame({
                type: 'system',
                subtype: 'api_retry',
                attempt: 1,
                max_retries: 10,
                retry_delay_ms: 5000,
                error_status: 529,
                error: `${marker} retrying`,
                uuid: 'retry',
                session_id: '',
              }),
            )
            yield* settle
            yield* result({ is_error: true, result: `${marker} failed`, api_error_status: 500 })
            yield* tick
            live()!.exit(new Error(`${marker} exited`))
          }),
        childRequest: ask('Bash', { command: 'ls' }, 'toolu_child', { agentID: 'agent_child' }),
        busyChild: notScripted('background subagents'),
        nativeTurn: () => null,
        received: () => received,
      },
    }
  }),
}

/** What the legacy-wrapped adapter fails today. ARCH-4b deletes each entry as it fixes it (PAR-B). */
contractSuite('Claude', driver, {
  usage_limit: 'A 429 / `rate_limit` result is classed `unknown`, not `usage_limit` (PAR-B item 5).',
  exit_mid_turn: 'Claude Code exiting mid-turn ends the turn as `unknown`, not `transport_error` (PAR-B item 5).',
  respond_after_expiry:
    'A permission request still open when its turn ends stays answerable, and the late reply reaches Claude Code.',
  foreign_terminal: "A background task's bookkeeping `result` ends the person's turn (PAR-B item 1, C-6).",
  self_started_turn:
    'Frames with no turn open start no turn, so the page never shows Working or Stop (PAR-B item 2, C-7).',
  provider_notice: 'A `<synthetic>` frame is drawn as answer text (PAR-B item 6, C-1).',
  passthrough:
    'Raw tool and MCP names in callout titles (`Using mcp__…`), the permission `displayName` in the card title, and `<synthetic>` text in the answer (C-1, C-3).',
})
