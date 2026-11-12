// The scenario-per-adapter registration (`itRunsReplayFixtures`), the scenario names (`simple`,
// `multi_turn`, `turn_interrupt`), the hold-and-release start gate (`ProviderReplayGate`) and the
// traps the scenarios cover are adapted from T3 Code (https://github.com/pingdotgg/t3code) at commit
// 5c6f2f12: apps/server/src/orchestration-v2/testkit/ProviderReplayFixtures.ts and fixtures/,
// packages/provider-testing/src/replayGate.ts, docs/orchestration-v2/testing-strategy.md and
// docs/internals/adding-a-provider.md ("Traps several providers hit").
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
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
  'passthrough',
  'title_stealth',
] as const
export type ScenarioName = (typeof SCENARIOS)[number]

/**
 * Scenarios an adapter fails today, each with why. They run as `it.fails`, so
 * the suite stays green and a gap that gets fixed fails until its entry is
 * deleted. Wave 3 (ARCH-4a/b/c) empties these lists.
 */
export type KnownGaps = Partial<Record<ScenarioName, string>>

/** One thing the adapter sent the provider. `target` names the native turn or session an interrupt was for. */
export type Received =
  | { readonly op: 'interrupt'; readonly target: string | null }
  | { readonly op: 'approve' | 'decline' }

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
  /** The provider asks the person to approve a command in the open turn. */
  readonly askFor: Effect.Effect<void>
  /** The open turn fails. The provider may also report the turn complete afterwards. */
  readonly fail: (kind: 'provider_error' | 'usage_limit') => Effect.Effect<void>
  /** The provider process, or its stream, dies mid-turn. */
  readonly exit: Effect.Effect<void>
  /** A terminal that is not the open turn's: a late one for an older turn, or a background task's bookkeeping. */
  readonly foreignTerminal: Effect.Effect<void>
  /** With no turn open, the provider starts one itself (a background task waking it) and streams `text`. */
  readonly selfStart: (text: string) => Effect.Effect<void>
  /** Mid-turn, the provider writes `text` about itself: a retry, a limit warning. */
  readonly notice: (text: string) => Effect.Effect<void>
  /**
   * Mid-turn, every provider-controlled string the fake can send carries `marker`: tool and
   * server names, request titles and reasons, error and retry messages, notices, stderr. Ends
   * with the process exiting.
   */
  readonly passthrough: (marker: string) => Effect.Effect<void>
  /**
   * The provider names the document `title`. Returns the document reopened when the provider
   * only reports a title as the document opens, and null when it tells the page live.
   */
  readonly nameDocument: (title: string) => Effect.Effect<OpenedThread | null, ProviderError>
  /** A request from a subagent session the adapter never saw created. */
  readonly childRequest: Effect.Effect<void>
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
  /** Scenarios this fake cannot produce, each with why. They are skipped, not counted as gaps. */
  readonly notScripted?: KnownGaps
}

/** For a script method a fake cannot produce; list its scenario in the driver's `notScripted`. */
export const notScripted = <A>(what: string): Effect.Effect<A> =>
  Effect.die(new Error(`This fake does not script ${what}`))

// ---- waiting ----------------------------------------------------------------------

/** Real time for a fake's promises and timers; the TestClock still owns every adapter deadline. */
export const tick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

/** Lets in-flight work settle. Used before asserting that something did not happen. */
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
  /** Every string the window showed at any point: block text, titles, the banner (and Details). */
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

    /** Records what the window would show now: blocks (without their ids), title and banner. */
    const look = () => {
      const snapshot = S.toSnapshot(state)
      for (const { id: _id, ...block } of snapshot.blocks) shown.add(JSON.stringify(block))
      shown.add(snapshot.title)
      if (titles.at(-1) !== snapshot.title) titles.push(snapshot.title)
      if (snapshot.error) shown.add(snapshot.error)
    }
    look()

    yield* Stream.runForEach(session.events, (event) =>
      Effect.sync(() => {
        events.push(event)
        if (isThreadEvent(event)) state = S.applyThreadEvent(state, provider, event, 0)
        // The manager puts a library notice on the banner.
        else if (event.type === 'notice') shown.add(event.message)
        look()
      }),
    ).pipe(Effect.forkScoped)
    // As the manager does: a backend that dies is noticed, and its sentence goes on the banner.
    yield* session.awaitExit.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          exited = true
          shown.add(error.message)
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
    yield* run.script.askFor
    const requestId = yield* openRequest(run)
    yield* run.session.respond(run.threadId, requestId, { accept, answers: {} })
    yield* until(() => decisions(run).length > 0, 'the provider received the decision')
    yield* run.script.answer('Done.')
    yield* awaitEnd(run, turnId)
    expect(decisions(run)).toEqual([{ op: accept ? 'approve' : 'decline' }])
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

const failureScenario = (kind: FailureClass & ('provider_error' | 'usage_limit')) => (run: Run) =>
  Effect.gen(function* () {
    const turnId = yield* begin(run, 'Summarise week 3')
    yield* run.script.fail(kind)
    const ended = yield* awaitEnd(run, turnId)
    expect(ended.status).toBe('failed')
    expect(ended.failure?.class).toBe(kind)
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
      expect(interrupts(run)).toHaveLength(1)
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
      expect(run.ended(turnId)).toMatchObject({ status: 'failed', failure: { class: 'transport_error' } })
    }),

  request_accept: requestScenario(true),
  request_decline: requestScenario(false),

  request_open_at_terminal: (run) =>
    Effect.gen(function* () {
      const requestId = yield* requestLeftOpen(run)
      // Expired requests show as skipped, and no longer wait on the person.
      expect(requestStatus(run, requestId)).toMatchObject({ resolved: 'skipped', pending: false })
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
      expect(outcome).toMatch(/Error$/)
      expect(decisions(run)).toHaveLength(decided)
      expect(run.blocks()).toEqual(before)
    }),

  foreign_terminal: (run) =>
    Effect.gen(function* () {
      const turnId = yield* begin(run, 'Run the long job')
      yield* run.script.foreignTerminal
      yield* settle
      expect(run.ended(turnId)).toBeUndefined()
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
      expect(start).toBeGreaterThanOrEqual(0)
      expect(start).toBeLessThan(firstItem)
      const turnId = (woken[start] as Extract<ThreadEvent, { type: 'turn.started' }>).turnId
      yield* run.session.interrupt(run.threadId, turnId)
      expect(yield* awaitEnd(run, turnId)).toMatchObject({ status: 'interrupted', failure: null })
    }),

  subagent_request: (run) =>
    Effect.gen(function* () {
      const turnId = yield* begin(run, 'Delegate it')
      yield* run.script.childRequest
      // On the document's own thread, where the person can answer it.
      yield* openRequest(run)
      yield* run.script.answer('Done.')
      yield* awaitEnd(run, turnId)
    }),

  subagent_outlives_stop: (run) =>
    Effect.gen(function* () {
      const turnId = yield* begin(run, 'Delegate it')
      const child = yield* run.script.busyChild
      yield* run.session.interrupt(run.threadId, turnId)
      yield* awaitEnd(run, turnId)
      expect(interrupts(run)).toContainEqual({ op: 'interrupt', target: child })
    }),

  provider_notice: (run) =>
    Effect.gen(function* () {
      const turnId = yield* begin(run, 'Summarise week 3')
      yield* run.script.notice(NOTICE)
      yield* run.script.answer('Week 3 covers attention.')
      yield* awaitEnd(run, turnId)
      expect(agentText(run)).not.toContain('ZZNOTE')
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

  passthrough: (run) =>
    Effect.gen(function* () {
      const turnId = yield* begin(run, 'Look it up')
      yield* run.script.passthrough(MARKER)
      yield* until(() => run.ended(turnId) !== undefined || run.exited(), 'the turn ended or the session exited')
      yield* settle
      // Provider text stays in the log; the page, cards, hovers, banner and Details never carry it.
      expect(run.shown().filter((text) => text.includes(MARKER))).toEqual([])
    }),

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
      expect(run.titles().flatMap(stealthViolations)).toEqual([])
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

const runScenario = (driver: ContractDriver, name: ScenarioName) =>
  Effect.gen(function* () {
    const run = yield* open(driver)
    yield* SCENARIO_BODIES[name](run)
    expect(contractViolations(run.thread(), run.opened)).toEqual([])
  }).pipe(Effect.scoped)

/**
 * Registers every scenario for one adapter (T3's `itRunsReplayFixtures`). A scenario in
 * `knownGaps` runs as `it.fails`; one in the driver's `notScripted` is skipped.
 */
export function contractSuite(name: string, driver: ContractDriver, knownGaps: KnownGaps) {
  describe(`${name} adapter contract`, () => {
    for (const scenario of SCENARIOS) {
      const skipped = driver.notScripted?.[scenario]
      if (skipped !== undefined) it.effect.skip(`${scenario} (not scripted: ${skipped})`, () => Effect.void)
      else if (knownGaps[scenario] !== undefined) it.effect.fails(scenario, () => runScenario(driver, scenario))
      else it.effect(scenario, () => runScenario(driver, scenario))
    }
  })
}
