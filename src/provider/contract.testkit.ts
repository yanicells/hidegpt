// Adapted from T3 Code (https://github.com/pingdotgg/t3code), its replay fixtures, replay gate, testing strategy and
// provider traps, at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import * as S from '../main/session/state'
import type { Block, ProviderId } from '../shared/model'
import { stealthViolations } from '../shared/stealth'
import type { ProviderError } from './errors'
import type { FailureClass, ThreadEvent, TurnId } from './events'
import {
  isThreadEvent,
  type AdapterEvent,
  type OpenedThread,
  type ProviderSession,
  type TurnSettings,
} from './ProviderAdapter'

/**
 * The adapter contract suite: the same scenarios, run against each adapter
 * over its in-process fake, so the three adapters are held to one contract
 * (`./events`). Each adapter's `*.contract.test.ts` supplies a driver (how to
 * make its fake do a thing) and its known gaps.
 *
 * What each scenario sees is what the window would: events are folded through
 * the session manager's real reducer (`state.ts`) and presented through
 * `present.ts`, as T3 Code's testing strategy asks (only the process boundary
 * is replaced). After every scenario one checker runs over the raw stream.
 *
 * The fakes are hand-written, so this proves the adapters agree with each
 * other and with our reading of each protocol. Only recorded fixtures prove
 * the protocols themselves (docs/replay-fixtures.md).
 */

export const SCENARIOS = [
  'simple',
  'multi_turn',
  'turn_interrupt',
  'interrupt_before_start',
  'provider_failure',
  'usage_limit',
  'exit_mid_turn',
  'request_accept',
  'request_decline',
  'request_open_at_terminal',
  'respond_after_expiry',
  'foreign_terminal',
  'self_started_turn',
  'subagent_request',
  'subagent_outlives_stop',
  'provider_notice',
  'terminal_once',
  'passthrough_tools',
  'passthrough_requests',
  'passthrough_notices',
  'passthrough_errors',
  'passthrough_crash',
  'title_stealth',
] as const
export type ScenarioName = (typeof SCENARIOS)[number]

/**
 * A scenario an adapter fails today, and why. The test passes only while the scenario fails as
 * listed, so a fixed gap turns red until its entry is deleted, and so does a gap that starts
 * failing for another reason (a driver timeout). Wave 3 (ARCH-4a/b/c) empties these lists.
 * - `fails`: text the failure message contains.
 * - `leaks` (`passthrough_*` only): every leaked `where: text` line, compared exactly, so a new
 *   leak in a source that already leaks still turns the test red. A leak can never pass as `fails`.
 */
export type KnownGap =
  | { readonly why: string; readonly fails: string }
  | { readonly why: string; readonly leaks: ReadonlyArray<string> }
export type KnownGaps = Partial<Record<ScenarioName, KnownGap>>

/** Where provider strings come from, one `passthrough_*` scenario each, so fixing one source never hides another. */
export type PassthroughSource = 'tools' | 'requests' | 'notices' | 'errors' | 'crash'

/**
 * One thing the adapter sent the provider. `target` names the native turn, session or task an
 * interrupt was for; `request` the native request a decision answered.
 */
export type Received =
  | { readonly op: 'interrupt'; readonly target: string | null }
  | { readonly op: 'approve' | 'decline'; readonly request: string }

/** When `fail('usage_limit')` says the limit resets, epoch ms (a whole second). */
export const RESETS_AT = 1_900_000_000_000

/** Holds the provider's acceptance of a new turn (T3's replay gate). */
export type Hold = {
  /** Succeeds once the turn's start request is waiting on the hold. */
  readonly reached: Effect.Effect<void>
  readonly release: Effect.Effect<void>
}

/**
 * How a scenario makes the fake do something. Every method acts on the
 * document the driver opened, and on its open turn where it says so.
 */
export interface ContractScript {
  /** Streams `text` as the open turn's answer, then completes the turn. */
  readonly answer: (text: string) => Effect.Effect<void>
  /** Holds the provider's acceptance of the next turn until `release`. */
  readonly holdStart: Effect.Effect<Hold>
  /** The provider asks the person to approve a command in the open turn; returns the request's native id. */
  readonly askFor: Effect.Effect<string>
  /** The open turn fails. The provider may also report the turn complete afterwards. */
  readonly fail: (kind: 'provider_error' | 'usage_limit') => Effect.Effect<void>
  /** What `fail('usage_limit')` tells the adapter about the reset: `RESETS_AT`, or null when the provider cannot say. */
  readonly usageResetAt: number | null
  /** The provider process, or its stream, dies mid-turn. */
  readonly exit: Effect.Effect<void>
  /**
   * A terminal that is not the new turn's: a late one for the turn stopped just before, or a
   * background task's bookkeeping. Sent while the new turn's start is held, so it races the
   * turn's admission.
   */
  readonly foreignTerminal: Effect.Effect<void>
  /** With no turn open, the provider starts one itself (a background task waking it) and streams `text`. */
  readonly selfStart: (text: string) => Effect.Effect<void>
  /** Mid-turn, the provider writes `text` about itself: a retry, a limit warning. */
  readonly notice: (text: string) => Effect.Effect<void>
  /**
   * Mid-turn, every provider-controlled string of `source` the fake can send carries `marker`.
   * `tools`: tool, server and namespace names, tool errors. `requests`: request titles, names,
   * reasons and messages. `notices`: warnings, retries, notices. `errors`: the turn's failure
   * text; it ends the turn failed. `crash`: stderr, then the process dies mid-turn. Returns the
   * provider values that cannot carry the marker (enum values); they must not reach the page either.
   */
  readonly passthrough: (source: PassthroughSource, marker: string) => Effect.Effect<ReadonlyArray<string>>
  /**
   * The provider names the document `title`. Returns the document reopened when the provider
   * only reports a title as the document opens, and null when it tells the page live.
   */
  readonly nameDocument: (title: string) => Effect.Effect<OpenedThread | null, ProviderError>
  /** A subagent the adapter never saw created asks to run a command; returns the request's native id. */
  readonly childRequest: Effect.Effect<string>
  /** A subagent of the open turn is working; returns its native id. */
  readonly busyChild: Effect.Effect<string>
  /** The native id the provider gave its newest turn, when it has one (for `Received.target`). */
  readonly nativeTurn: () => string | null
  /** What the provider received from the adapter, in order. */
  readonly received: () => ReadonlyArray<Received>
}

/** Opens a session on a fresh fake, with one document open, and the script that drives that fake. */
export interface ContractDriver {
  readonly provider: ProviderId
  readonly settings: TurnSettings
  readonly open: Effect.Effect<
    { readonly session: ProviderSession; readonly opened: OpenedThread; readonly script: ContractScript },
    ProviderError,
    Scope.Scope
  >
}

// ---- waiting ----------------------------------------------------------------------

/** Real time for a fake's promises and timers; the TestClock still owns every adapter deadline. */
export const tick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

/**
 * Lets in-flight work settle. Used before asserting that something did not happen. It counts
 * event-loop turns, not time: a fake's push reaches the reducer within a few turns (stream,
 * queue, fold), so 20 leaves a wide margin without waiting on a clock.
 */
export const settle = Effect.repeat(tick, { times: 20 })

/** Waits (in real ticks) until `check` holds, or fails naming `what`. */
export const until = (check: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 300 && !check(); i += 1) yield* tick
    if (!check()) return yield* Effect.die(new Error(`Timed out waiting until ${what}`))
  })

// ---- one scenario run -------------------------------------------------------------

type Ended = Extract<ThreadEvent, { type: 'turn.ended' }>

/** Everything a scenario can do and see. */
type Run = {
  readonly session: ProviderSession
  readonly threadId: string
  readonly opened: OpenedThread
  readonly script: ContractScript
  /** This document's events, in order. */
  readonly thread: () => ReadonlyArray<ThreadEvent>
  /** Every string the window showed at any point, as `where: text` (`callout.title: …`, `banner: …`). */
  readonly shown: () => ReadonlyArray<string>
  readonly blocks: () => ReadonlyArray<Block>
  /** Every page and window title the document had, in order. */
  readonly titles: () => ReadonlyArray<string>
  /** Takes in the document as reopened, as the session manager does. */
  readonly adopt: (opened: OpenedThread) => void
  /** Sends a message under a fresh app turn id; succeeds once the provider accepted it. */
  readonly send: (text: string) => Effect.Effect<TurnId, ProviderError>
  readonly started: (turnId: TurnId) => boolean
  readonly ended: (turnId: TurnId) => Ended | undefined
  /** `session.awaitExit`'s failure, observed as the session manager does. */
  readonly exited: () => boolean
}

const open = (driver: ContractDriver) =>
  Effect.gen(function* () {
    const { session, opened, script } = yield* driver.open
    const { provider } = driver
    const threadId = opened.threadId
    const events: AdapterEvent[] = []
    const shown = new Set<string>()
    const titles: string[] = []
    let state = S.showThread(
      S.adopt(
        S.initialState(provider, () => '/tmp'),
        provider,
        opened,
        0,
      ),
      provider,
      threadId,
    )
    let exited = false
    let turns = 0

    /** Adds every string in `value` under its path (`approval.fields.label`), ids and kinds aside. */
    const record = (where: string, value: unknown): void => {
      if (typeof value === 'string') {
        if (value) shown.add(`${where}: ${value}`)
      } else if (Array.isArray(value)) for (const item of value) record(where, item)
      else if (value !== null && typeof value === 'object') {
        for (const [key, field] of Object.entries(value))
          if (key !== 'id' && key !== 'kind') record(`${where}.${key}`, field)
      }
    }
    /** Records what the window would show now: blocks, title and banner (Details shows the banner's text). */
    const look = () => {
      const snapshot = S.toSnapshot(state)
      for (const block of snapshot.blocks) record(block.kind, block)
      record('title', snapshot.title)
      if (titles.at(-1) !== snapshot.title) titles.push(snapshot.title)
      if (snapshot.error) record('banner', snapshot.error)
    }
    look()

    yield* Stream.runForEach(session.events, (event) =>
      Effect.sync(() => {
        events.push(event)
        if (isThreadEvent(event)) state = S.applyThreadEvent(state, provider, event, 0)
        // The manager puts a library notice on the banner.
        else if (event.type === 'notice') record('banner', event.message)
        look()
      }),
    ).pipe(Effect.forkScoped)
    // As the manager does: a backend that dies is noticed, and its sentence goes on the banner.
    yield* session.awaitExit.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          exited = true
          record('banner', error.message)
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    )

    const thread = () =>
      events.filter((event): event is ThreadEvent => isThreadEvent(event) && event.threadId === threadId)
    const run: Run = {
      session,
      threadId,
      opened,
      script,
      thread,
      shown: () => [...shown],
      blocks: () => S.toSnapshot(state).blocks,
      titles: () => titles,
      adopt: (reopened) => {
        state = S.showThread(S.adopt(state, provider, reopened, 0), provider, threadId)
        look()
      },
      send: (text) =>
        Effect.gen(function* () {
          turns += 1
          const turnId = `turn-${turns}`
          const input = { text, images: [], skill: null, clientId: session.messageId() }
          yield* session.send(threadId, turnId, input, driver.settings)
          return turnId
        }),
      started: (turnId) => thread().some((event) => event.type === 'turn.started' && event.turnId === turnId),
      ended: (turnId) =>
        thread().find((event): event is Ended => event.type === 'turn.ended' && event.turnId === turnId),
      exited: () => exited,
    }
    return run
  })

// ---- helpers the scenarios share ----------------------------------------------------

/** Sends `text` and waits for its turn to start. */
const begin = (run: Run, text: string) =>
  Effect.gen(function* () {
    const turnId = yield* run.send(text)
    yield* until(() => run.started(turnId), `${turnId} started`)
    return turnId
  })

const awaitEnd = (run: Run, turnId: TurnId) =>
  Effect.gen(function* () {
    yield* until(() => run.ended(turnId) !== undefined, `${turnId} ended`)
    yield* settle
    return run.ended(turnId)!
  })

/** A full turn that completes. */
const answeredTurn = (run: Run, text: string, answer: string) =>
  Effect.gen(function* () {
    const turnId = yield* begin(run, text)
    yield* run.script.answer(answer)
    return yield* awaitEnd(run, turnId)
  })

const interrupts = (run: Run) => run.script.received().filter((item) => item.op === 'interrupt')
const decisions = (run: Run) => run.script.received().filter((item) => item.op !== 'interrupt')

const agentText = (run: Run) =>
  run
    .blocks()
    .flatMap((block) => (block.kind === 'agent' ? [block.text] : []))
    .join('\n')

/** The newest request's id, once one is open on the page. */
const openRequest = (run: Run) =>
  Effect.gen(function* () {
    const pending = () => run.blocks().findLast((block) => block.kind === 'approval' && block.resolved === null)
    yield* until(() => pending() !== undefined, 'a request is open on the page')
    return pending()!.id
  })

const requestScenario = (accept: boolean) => (run: Run) =>
  Effect.gen(function* () {
    const turnId = yield* begin(run, 'Clean up the folder')
    const asked = yield* run.script.askFor
    const requestId = yield* openRequest(run)
    yield* run.session.respond(run.threadId, requestId, { accept, answers: {} })
    yield* until(() => decisions(run).length > 0, 'the provider received the decision')
    yield* run.script.answer('Done.')
    yield* awaitEnd(run, turnId)
    expect(decisions(run)).toEqual([{ op: accept ? 'approve' : 'decline', request: asked }])
  })

/** A request still open when its turn completes. Returns its id. */
const requestLeftOpen = (run: Run) =>
  Effect.gen(function* () {
    const turnId = yield* begin(run, 'Clean up the folder')
    yield* run.script.askFor
    const requestId = yield* openRequest(run)
    yield* run.script.answer('Done.')
    yield* awaitEnd(run, turnId)
    return requestId
  })

const requestStatus = (run: Run, requestId: string) =>
  run.blocks().find((block) => block.id === requestId && block.kind === 'approval')

/** A request still open when its turn ends by `end`; it must show as skipped, waiting on no one. */
const requestExpiresWhen = (run: Run, how: string, end: (turnId: TurnId) => Effect.Effect<void, ProviderError>) =>
  Effect.gen(function* () {
    const turnId = yield* begin(run, 'Clean up the folder')
    yield* run.script.askFor
    const requestId = yield* openRequest(run)
    yield* end(turnId)
    yield* until(() => run.ended(turnId) !== undefined || run.exited(), `${turnId} ended (${how})`)
    yield* settle
    expect(requestStatus(run, requestId), `a request open at ${how} shows as skipped`).toMatchObject({
      resolved: 'skipped',
      pending: false,
    })
  })

const failureScenario = (kind: FailureClass & ('provider_error' | 'usage_limit')) => (run: Run) =>
  Effect.gen(function* () {
    const turnId = yield* begin(run, 'Summarise week 3')
    yield* run.script.fail(kind)
    const ended = yield* awaitEnd(run, turnId)
    expect(ended.status).toBe('failed')
    expect(ended.failure?.class, 'the failure class').toBe(kind)
    if (kind === 'usage_limit') expect(ended.failure?.resetAt, 'when the limit resets').toBe(run.script.usageResetAt)
  })

/** What a `passthrough_*` scenario fails with: each leaked `where: text` line, sorted. A gap's `leaks` lists them. */
export class Leaked extends Error {
  constructor(readonly lines: ReadonlyArray<string>) {
    super(['Provider text on the page:', ...lines].join('\n  '))
  }
}

/** The block a source must draw, so a hidden string is told apart from one that never arrived. */
const DRAWS: Partial<Record<PassthroughSource, Block['kind']>> = { tools: 'callout', requests: 'approval' }

const passthroughScenario = (source: PassthroughSource) => (run: Run) =>
  Effect.gen(function* () {
    const turnId = yield* begin(run, 'Look it up')
    const raw = yield* run.script.passthrough(source, MARKER)
    const draws = DRAWS[source]
    if (draws) yield* until(() => run.blocks().some((block) => block.kind === draws), `a ${draws} is on the page`)
    if (source === 'errors' || source === 'crash') {
      yield* until(() => run.ended(turnId) !== undefined || run.exited(), 'the turn ended or the session exited')
    } else {
      yield* settle
      yield* run.script.answer('Done.')
      yield* awaitEnd(run, turnId)
    }
    yield* settle
    // Provider text stays in the log; the page, cards, hovers, banner and Details never carry it.
    const leaked = run
      .shown()
      .filter((line) => line.includes(MARKER) || raw.some((value) => line.includes(value)))
      .sort()
    if (leaked.length > 0) return yield* Effect.die(new Leaked(leaked))
  })

/** Text a provider writes about itself; it must never read as the document's answer. */
const NOTICE = 'ZZNOTE retrying in 5 seconds'

/** The marker every provider-controlled string carries in `passthrough`. */
const MARKER = 'ZZPROV'

// ---- the scenarios ----------------------------------------------------------------

type Scenario = (run: Run) => Effect.Effect<void, ProviderError, Scope.Scope>

const SCENARIO_BODIES: Record<ScenarioName, Scenario> = {
  simple: (run) =>
    Effect.gen(function* () {
      const ended = yield* answeredTurn(run, 'Why are leaves green?', 'Because of chlorophyll.')
      expect(ended).toMatchObject({ status: 'completed', failure: null })
      expect(run.thread().some((event) => event.type === 'item.delta')).toBe(true)
      expect(agentText(run)).toContain('Because of chlorophyll.')
    }),

  multi_turn: (run) =>
    Effect.gen(function* () {
      const first = yield* answeredTurn(run, 'First question', 'First answer.')
      const second = yield* answeredTurn(run, 'Second question', 'Second answer.')
      expect(second.turnId).not.toBe(first.turnId)
      expect([first.status, second.status]).toEqual(['completed', 'completed'])
      expect(agentText(run)).toContain('Second answer.')
    }),

  turn_interrupt: (run) =>
    Effect.gen(function* () {
      const turnId = yield* begin(run, 'Write a long essay')
      yield* run.session.interrupt(run.threadId, turnId)
      const ended = yield* awaitEnd(run, turnId)
      expect(ended).toMatchObject({ status: 'interrupted', failure: null })
      expect(interrupts(run), 'Stop names the running turn').toEqual([
        { op: 'interrupt', target: run.script.nativeTurn() },
      ])
    }),

  interrupt_before_start: (run) =>
    Effect.gen(function* () {
      const hold = yield* run.script.holdStart
      const sending = yield* run.send('Write a long essay').pipe(Effect.forkScoped)
      yield* hold.reached
      // Stop pressed while the provider has not yet accepted the turn.
      const stopping = yield* run.session.interrupt(run.threadId, 'turn-1').pipe(Effect.exit, Effect.forkScoped)
      yield* settle
      yield* hold.release
      expect(yield* Fiber.join(sending)).toBe('turn-1')
      yield* Fiber.join(stopping)
      const ended = yield* awaitEnd(run, 'turn-1')
      expect(ended).toMatchObject({ status: 'interrupted', failure: null })
      expect(interrupts(run)).toEqual([{ op: 'interrupt', target: run.script.nativeTurn() }])
    }),

  provider_failure: failureScenario('provider_error'),
  usage_limit: failureScenario('usage_limit'),

  exit_mid_turn: (run) =>
    Effect.gen(function* () {
      const turnId = yield* begin(run, 'Summarise week 3')
      yield* run.script.exit
      yield* until(() => run.ended(turnId) !== undefined || run.exited(), 'the turn ended or the session exited')
      yield* settle
      expect(run.ended(turnId), 'the turn ends as a lost connection').toMatchObject({
        status: 'failed',
        failure: { class: 'transport_error' },
      })
    }),

  request_accept: requestScenario(true),
  request_decline: requestScenario(false),

  // Expired requests show as skipped, and no longer wait on the person, however the turn ends.
  request_open_at_terminal: (run) =>
    Effect.gen(function* () {
      const requestId = yield* requestLeftOpen(run)
      expect(requestStatus(run, requestId), 'a request open at completion shows as skipped').toMatchObject({
        resolved: 'skipped',
        pending: false,
      })
      yield* requestExpiresWhen(run, 'Stop', (turnId) => run.session.interrupt(run.threadId, turnId))
      yield* requestExpiresWhen(run, 'a failure', () => run.script.fail('provider_error'))
      yield* requestExpiresWhen(run, 'an exit', () => run.script.exit)
    }),

  respond_after_expiry: (run) =>
    Effect.gen(function* () {
      const requestId = yield* requestLeftOpen(run)
      const before = run.blocks()
      // A request the adapter withdrew at the terminal may have sent the provider a refusal already.
      const decided = decisions(run).length
      const outcome = yield* run.session
        .respond(run.threadId, requestId, { accept: true, answers: {} })
        .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => 'taken' }))
      yield* settle
      expect(outcome, 'a reply to an expired request is refused').toMatch(/Error$/)
      expect(decisions(run)).toHaveLength(decided)
      expect(run.blocks()).toEqual(before)
    }),

  // The terminal lands while the new turn is being admitted (T3's admission, PAR-C item 2).
  foreign_terminal: (run) =>
    Effect.gen(function* () {
      // Stop, then a quick resend: the stopped turn's late terminal can land during the resend.
      const stopped = yield* begin(run, 'Run the long job')
      yield* run.session.interrupt(run.threadId, stopped)
      yield* awaitEnd(run, stopped)
      const hold = yield* run.script.holdStart
      const sending = yield* run.send('Run it again').pipe(Effect.forkScoped)
      yield* hold.reached
      const late = yield* run.script.foreignTerminal.pipe(Effect.forkScoped)
      yield* settle
      yield* hold.release
      const turnId = yield* Fiber.join(sending)
      yield* Fiber.join(late)
      yield* settle
      expect(run.ended(turnId), "a terminal that is not this turn's leaves it running").toBeUndefined()
      yield* run.script.answer('The job is done.')
      expect(yield* awaitEnd(run, turnId)).toMatchObject({ status: 'completed' })
    }),

  self_started_turn: (run) =>
    Effect.gen(function* () {
      yield* answeredTurn(run, 'Start the background job', 'Started it.')
      const before = run.thread().length
      yield* run.script.selfStart('The background job finished.')
      yield* until(() => agentText(run).includes('The background job finished.'), 'the woken answer shows')
      const woken = run.thread().slice(before)
      const firstItem = woken.findIndex((event) => event.type === 'item.upserted' || event.type === 'item.delta')
      const start = woken.findIndex((event) => event.type === 'turn.started')
      // The page shows Working (and Stop) for work the provider started itself.
      expect(start, 'a turn the provider starts itself shows as started').toBeGreaterThanOrEqual(0)
      expect(start).toBeLessThan(firstItem)
      const turnId = (woken[start] as Extract<ThreadEvent, { type: 'turn.started' }>).turnId
      yield* run.session.interrupt(run.threadId, turnId)
      expect(yield* awaitEnd(run, turnId)).toMatchObject({ status: 'interrupted', failure: null })
    }),

  subagent_request: (run) =>
    Effect.gen(function* () {
      const turnId = yield* begin(run, 'Delegate it')
      const asked = yield* run.script.childRequest
      // On the document's own thread, where the person can answer it.
      const requestId = yield* openRequest(run)
      yield* run.session.respond(run.threadId, requestId, { accept: true, answers: {} })
      yield* until(() => decisions(run).length > 0, 'the subagent received the decision')
      expect(decisions(run), 'the decision reaches the subagent').toEqual([{ op: 'approve', request: asked }])
      yield* run.script.answer('Done.')
      yield* awaitEnd(run, turnId)
    }),

  subagent_outlives_stop: (run) =>
    Effect.gen(function* () {
      const turnId = yield* begin(run, 'Delegate it')
      const child = yield* run.script.busyChild
      yield* run.session.interrupt(run.threadId, turnId)
      yield* awaitEnd(run, turnId)
      expect(interrupts(run), 'Stop reaches the busy subagent').toContainEqual({ op: 'interrupt', target: child })
    }),

  provider_notice: (run) =>
    Effect.gen(function* () {
      const turnId = yield* begin(run, 'Summarise week 3')
      yield* run.script.notice(NOTICE)
      yield* run.script.answer('Week 3 covers attention.')
      yield* awaitEnd(run, turnId)
      expect(agentText(run), 'provider notices stay off the answer').not.toContain('ZZNOTE')
    }),

  terminal_once: (run) =>
    Effect.gen(function* () {
      const completed = yield* answeredTurn(run, 'First', 'Done.')
      const stopped = yield* begin(run, 'Second')
      yield* run.session.interrupt(run.threadId, stopped)
      yield* awaitEnd(run, stopped)
      const failed = yield* begin(run, 'Third')
      yield* run.script.fail('provider_error')
      yield* awaitEnd(run, failed)
      const ended = run.thread().filter((event): event is Ended => event.type === 'turn.ended')
      expect(ended.map((event) => [event.turnId, event.status])).toEqual([
        [completed.turnId, 'completed'],
        [stopped, 'interrupted'],
        [failed, 'failed'],
      ])
    }),

  passthrough_tools: passthroughScenario('tools'),
  passthrough_requests: passthroughScenario('requests'),
  passthrough_notices: passthroughScenario('notices'),
  passthrough_errors: passthroughScenario('errors'),
  passthrough_crash: passthroughScenario('crash'),

  // A provider's title summarises the person's own content, so it reaches the page (D5), unless
  // it would make the page read as an AI tool.
  title_stealth: (run) =>
    Effect.gen(function* () {
      yield* answeredTurn(run, 'Summarise week 3', 'Week 3 covers attention.')
      const name = (title: string) =>
        Effect.gen(function* () {
          const reopened = yield* run.script.nameDocument(title)
          if (reopened) run.adopt(reopened)
          yield* settle
        })
      yield* name('Week 3 reading notes')
      expect(run.titles().at(-1)).toBe('Week 3 reading notes')
      yield* name('Claude Code session')
      yield* name('Ask GPT about photosynthesis')
      expect(run.titles().flatMap(stealthViolations), 'no title names a vendor or model').toEqual([])
      expect(run.titles().at(-1)?.trim()).not.toBe('')
    }),
}

// ---- the stream checker -------------------------------------------------------------

/**
 * The contract every event stream keeps, per thread: turns never overlap, each turn id
 * starts once and ends once, streaming happens inside a turn, an item stamped with a turn
 * names the open one, and every delta names an item already seen (or says how to create it).
 * An upsert stamped with no turn (history, a request settled after its turn) may come anywhere.
 */
export function contractViolations(events: ReadonlyArray<AdapterEvent>, opened: OpenedThread): string[] {
  const violations: string[] = []
  const open = new Map<string, TurnId>()
  const startedIds = new Set<string>()
  const endedIds = new Set<string>()
  const known = new Set(opened.items.map((item) => `${opened.threadId}/${item.id}`))
  if (opened.activeTurnId !== null) {
    open.set(opened.threadId, opened.activeTurnId)
    startedIds.add(opened.activeTurnId)
  }
  for (const event of events) {
    if (!isThreadEvent(event)) continue
    const current = open.get(event.threadId)
    switch (event.type) {
      case 'turn.started':
        if (startedIds.has(event.turnId)) violations.push(`${event.turnId} started twice`)
        if (current !== undefined) violations.push(`${event.turnId} started while ${current} was open`)
        startedIds.add(event.turnId)
        open.set(event.threadId, event.turnId)
        break
      case 'turn.ended':
        if (endedIds.has(event.turnId)) violations.push(`${event.turnId} ended twice`)
        else if (current !== event.turnId) violations.push(`${event.turnId} ended but ${current ?? 'no turn'} was open`)
        if ((event.status === 'failed') !== (event.failure !== null))
          violations.push(`${event.turnId} ended ${event.status} with failure ${JSON.stringify(event.failure)}`)
        endedIds.add(event.turnId)
        if (current === event.turnId) open.delete(event.threadId)
        break
      case 'item.upserted':
        if (event.turnId !== null && event.turnId !== current)
          violations.push(`${event.item.id} stamped ${event.turnId} while ${current ?? 'no turn'} was open`)
        known.add(`${event.threadId}/${event.item.id}`)
        break
      case 'item.delta':
        if (current === undefined) violations.push(`${event.itemId} streamed with no turn open`)
        if (!known.has(`${event.threadId}/${event.itemId}`) && !event.create)
          violations.push(`${event.itemId} streamed before it was announced`)
        known.add(`${event.threadId}/${event.itemId}`)
        break
      case 'thread.reset':
        for (const item of event.items) known.add(`${event.threadId}/${item.id}`)
        if (event.activeTurnId === null) open.delete(event.threadId)
        else {
          open.set(event.threadId, event.activeTurnId)
          startedIds.add(event.activeTurnId)
        }
        break
      case 'thread.renamed':
      case 'thread.closed':
        break
    }
  }
  for (const [threadId, turnId] of open) violations.push(`${turnId} on ${threadId} never ended`)
  return violations
}

// ---- registration -----------------------------------------------------------------

/** Runs one scenario on a fresh fake, then holds its event stream to the contract. */
export const runScenario = (driver: ContractDriver, name: ScenarioName) =>
  Effect.gen(function* () {
    const run = yield* open(driver)
    yield* SCENARIO_BODIES[name](run)
    const violations = contractViolations(run.thread(), run.opened)
    if (violations.length > 0) {
      return yield* Effect.die(new Error(['The event stream breaks the contract:', ...violations].join('\n  ')))
    }
  }).pipe(Effect.scoped)

/** The message a failed run failed with: an assertion, a timeout, or a provider error. */
export const failureMessage = (exit: Exit.Exit<unknown, unknown>): string | null => {
  if (Exit.isSuccess(exit)) return null
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

/** Passes while the scenario fails as the gap lists; says why when it does not. */
export const expectGap = (gap: KnownGap) => (exit: Exit.Exit<unknown, unknown>) =>
  Effect.sync(() => {
    const message = failureMessage(exit)
    if (message === null) throw new Error(`Passes now: delete this known gap (${gap.why})`)
    const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)
    if ('leaks' in gap) {
      if (!(error instanceof Leaked)) throw new Error(`Fails for another reason than its known leaks.\nGot: ${message}`)
      expect(error.lines, 'every leaked line, exactly').toEqual([...gap.leaks].sort())
    } else if (error instanceof Leaked) {
      throw new Error(`Leaks provider text: list every line as the gap's \`leaks\`.\nGot: ${message}`)
    } else if (!message.includes(gap.fails)) {
      throw new Error(`Fails for another reason than its known gap.\nExpected: ${gap.fails}\nGot: ${message}`)
    }
  })

/**
 * Registers every scenario for one adapter (T3's `itRunsReplayFixtures`). A scenario in
 * `knownGaps` passes only while it fails as listed.
 */
export function contractSuite(name: string, driver: ContractDriver, knownGaps: KnownGaps) {
  describe(`${name} adapter contract`, () => {
    for (const scenario of SCENARIOS) {
      const gap = knownGaps[scenario]
      if (gap !== undefined && 'leaks' in gap && !scenario.startsWith('passthrough_')) {
        throw new Error(`${name} ${scenario}: only a passthrough gap lists \`leaks\``)
      }
      if (gap !== undefined) {
        it.effect(`${scenario} (known gap)`, () =>
          runScenario(driver, scenario).pipe(Effect.exit, Effect.flatMap(expectGap(gap))),
        )
      } else it.effect(scenario, () => runScenario(driver, scenario))
    }
  })
}
