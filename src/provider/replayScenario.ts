import type * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'

import type { AdapterEvent, OpenedThread, ProviderSession, TurnSettings } from './ProviderAdapter'

/**
 * A replay scenario is written once and run twice: by a recorder against the
 * real CLI (scripts/record-*-replay.ts) and by a replay test against the
 * recording. The turn, stop and approval builders here are shared by both
 * providers; each provider's `replayScenarios.ts` lists its own.
 */

export const SETTINGS: TurnSettings = { model: null, effort: null, serviceTier: null, mode: null }

export type ScenarioContext = {
  readonly session: ProviderSession
  /** Everything the session emitted so far; the runner keeps appending. */
  readonly events: ReadonlyArray<AdapterEvent>
  readonly workspace: string
  /** How long to wait for a turn: minutes for a real model, seconds in a replay. */
  readonly wait: Duration.Input
  /** Runs once the catalog has loaded. The no-prompt recorders stop here if a login turned up. */
  readonly afterCatalog: Effect.Effect<void, unknown>
}

export type ReplayScenario<A> = {
  readonly description: string
  /** Prompts sent to the model, in order. Empty means no turn, so any agent may record it. */
  readonly prompts: ReadonlyArray<string>
  readonly run: (context: ScenarioContext) => Effect.Effect<A, unknown>
}

type TurnEnded = Extract<AdapterEvent, { type: 'turnEnded' }>

/** What a turn scenario leaves: every turn's end, in order, and the document read back. */
export type TurnResult = {
  readonly ended: ReadonlyArray<TurnEnded>
  readonly opened: OpenedThread
}

const ofThread = (threadId: string) => (event: AdapterEvent) => 'threadId' in event && event.threadId === threadId

/** Polls the event list until `done` holds; fails with `what` after `context.wait`. */
const waitFor = (context: ScenarioContext, what: string, done: () => boolean) =>
  Effect.suspend(() => (done() ? Effect.void : Effect.sleep('10 millis').pipe(Effect.repeat({ until: done })))).pipe(
    Effect.timeoutOrElse({ duration: context.wait, orElse: () => Effect.fail(new Error(`Timed out waiting for ${what}.`)) }),
  )

/** Sends one prompt and waits for its turn to end; `during` runs while the turn is going (a stop, an approval). */
const runTurn = (
  context: ScenarioContext,
  threadId: string,
  text: string,
  index: number,
  during: (since: number) => Effect.Effect<void, unknown> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const turnEnded = () => context.events.filter((event): event is TurnEnded => event.type === 'turnEnded' && event.threadId === threadId)
    const before = turnEnded().length
    const since = context.events.length
    yield* context.session.send(threadId, { text, images: [], skill: null, clientId: `local-replay-${index + 1}` }, SETTINGS)
    yield* during(since)
    yield* waitFor(context, `turn ${index + 1} to end`, () => turnEnded().length > before)
    return turnEnded()[before]!
  })

/** A new document, then `body` on it, then the document read back and released. */
const onNewDocument = (
  context: ScenarioContext,
  body: (threadId: string) => Effect.Effect<ReadonlyArray<TurnEnded>, unknown>,
) =>
  Effect.gen(function* () {
    const created = yield* context.session.createThread({ cwd: context.workspace, projectId: null, title: null, settings: SETTINGS })
    const ended = yield* body(created.threadId)
    const opened = yield* context.session.openThread(created.threadId)
    yield* context.session.releaseThread(created.threadId)
    return { ended, opened } satisfies TurnResult
  })

/** Each prompt to the end of its turn. */
export const turnScenario = (prompts: ReadonlyArray<string>): ReplayScenario<TurnResult> => ({
  description: `A new document, ${prompts.length} short turns, then the document opened again to read its history.`,
  prompts,
  run: (context) =>
    onNewDocument(context, (threadId) =>
      Effect.forEach(prompts, (text, index) => runTurn(context, threadId, text, index)),
    ),
})

/** One long answer, stopped once its first words arrive. */
export const stopScenario = (prompt: string): ReplayScenario<TurnResult> => ({
  description: 'A new document and one long answer, stopped once it starts; then the document read back.',
  prompts: [prompt],
  run: (context) =>
    onNewDocument(context, (threadId) =>
      runTurn(context, threadId, prompt, 0, (since) =>
        Effect.gen(function* () {
          const started = () => context.events.slice(since).some((event) => event.type === 'text' && ofThread(threadId)(event))
          yield* waitFor(context, 'the answer to start', started)
          yield* context.session.interrupt(threadId)
        }),
      ).pipe(Effect.map((ended) => [ended])),
    ),
})

/**
 * One turn per prompt, each asking before it acts. `decisions[i]` answers every
 * approval in turn i (a model may ask again after a deny or a sandbox error).
 * Fails if a turn ends without asking, since then the recording would show no
 * approval at all.
 */
export const approvalScenario = (prompts: ReadonlyArray<string>, decisions: ReadonlyArray<boolean>): ReplayScenario<TurnResult> => {
  if (decisions.length < prompts.length) throw new Error(`${prompts.length} approval prompts need as many decisions; got ${decisions.length}.`)
  return {
    description: `A new document and ${prompts.length} turns that each ask before acting: ${decisions.map((accept) => (accept ? 'accepted' : 'denied')).join(', then ')}. Then the document read back.`,
    prompts,
    run: (context) =>
      onNewDocument(context, (threadId) =>
        Effect.forEach(prompts, (text, index) =>
          runTurn(context, threadId, text, index, (since) =>
            Effect.gen(function* () {
              const accept = decisions[index]!
              const answered = new Set<string>()
              const fresh = () => context.events.slice(since).filter(ofThread(threadId))
              const ended = () => fresh().some((event) => event.type === 'turnEnded')
              const unanswered = () =>
                fresh().flatMap((event) => (event.type === 'block' && event.block.kind === 'approval' && !answered.has(event.block.id) ? [event.block] : []))[0]
              // Answer each request as it comes, until the turn ends.
              while (true) {
                yield* waitFor(context, 'an approval request or the end of the turn', () => unanswered() !== undefined || ended())
                const block = unanswered()
                if (!block) break
                answered.add(block.id)
                yield* context.session.respond(threadId, block.id, { accept, answers: {} })
              }
              if (answered.size === 0) {
                return yield* Effect.fail(new Error(`Turn ${index + 1} ended without asking for approval; see docs/replay-fixtures.md.`))
              }
            }),
          ),
        ),
      ),
  }
}

// Fixed and harmless; both providers send the same ones.
export const TURN_PROMPTS = ['Reply with one short sentence about tea.', 'Now say it again in five words or fewer.']
export const STOP_PROMPT = 'Count from 1 to 300, one number per line, with no other text.'
/** The first is accepted and the second denied, so tea.txt is made and then kept. */
export const APPROVAL_PROMPTS = [
  'Create a file named tea.txt in the current folder that contains the word tea.',
  'Now delete tea.txt.',
]
export const APPROVAL_DECISIONS = [true, false]
