import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { describe, expect, it } from 'vitest'

import { contractViolations, expectGap, judge } from './contract.checks'
import type { ThreadEvent } from './events'
import type { OpenedThread } from './ProviderAdapter'

/** The contract checker itself: a lenient checker would let every adapter scenario pass. */

const T = 'thr'
const opened: OpenedThread = {
  threadId: T,
  title: 'Notes',
  items: [],
  olderCursor: null,
  cwd: '/tmp',
  activeTurnId: null,
}
const answer = { kind: 'assistant', id: 'a1', text: '', phase: 'final' } as const

const started = (turnId: string): ThreadEvent => ({ type: 'turn.started', threadId: T, turnId })
const ended = (turnId: string, status: 'completed' | 'failed' = 'completed', failed = status === 'failed') =>
  ({
    type: 'turn.ended',
    threadId: T,
    turnId,
    status,
    failure: failed ? { class: 'provider_error', detail: 'x', retryable: true, resetAt: null } : null,
  }) satisfies ThreadEvent
const upserted = (turnId: string | null): ThreadEvent => ({ type: 'item.upserted', threadId: T, turnId, item: answer })
const delta = (itemId = 'a1'): ThreadEvent => ({ type: 'item.delta', threadId: T, itemId, delta: 'hi' })

describe('contractViolations', () => {
  it('accepts a well-formed turn, a delta that creates its item, and a turn adopted on open', () => {
    expect(
      contractViolations(
        [
          started('t1'),
          upserted('t1'),
          delta(),
          { type: 'item.delta', threadId: T, itemId: 'a2', delta: 'x', create: { ...answer, id: 'a2' } },
          ended('t1'),
          upserted(null),
        ],
        opened,
      ),
    ).toEqual([])
    expect(
      contractViolations([delta('a9'), ended('t0')], {
        ...opened,
        items: [{ ...answer, id: 'a9' }],
        activeTurnId: 't0',
      }),
    ).toEqual([])
  })

  it('flags each broken rule', () => {
    expect(contractViolations([started('t1'), ended('t1'), ended('t1')], opened)).toEqual(['t1 ended twice'])
    expect(contractViolations([started('t1'), started('t2'), ended('t2')], opened)).toEqual([
      't2 started while t1 was open',
    ])
    expect(contractViolations([started('t1'), ended('t1'), started('t1'), ended('t1')], opened)).toContain(
      't1 started twice',
    )
    expect(contractViolations([ended('t9')], opened)).toEqual(['t9 ended but no turn was open'])
    expect(contractViolations([started('t1'), ended('t1', 'completed', true)], opened)).toHaveLength(1)
    expect(contractViolations([started('t1'), ended('t1', 'failed', false)], opened)).toHaveLength(1)
    expect(contractViolations([started('t1'), upserted('t0'), ended('t1')], opened)).toEqual([
      'a1 stamped t0 while t1 was open',
    ])
    expect(contractViolations([started('t1'), ended('t1'), upserted('t1')], opened)).toEqual([
      'a1 stamped t1 while no turn was open',
    ])
    expect(contractViolations([upserted(null), delta()], opened)).toEqual(['a1 streamed with no turn open'])
    expect(contractViolations([started('t1'), delta(), ended('t1')], opened)).toEqual([
      'a1 streamed before it was announced',
    ])
    expect(contractViolations([started('t1')], opened)).toEqual(['t1 on thr never ended'])
  })

  it('takes a reset as the new truth for items and the open turn', () => {
    const reset = (activeTurnId: string | null): ThreadEvent => ({
      type: 'thread.reset',
      threadId: T,
      items: [answer],
      activeTurnId,
    })
    expect(contractViolations([started('t1'), reset(null), upserted(null)], opened)).toEqual([])
    expect(contractViolations([reset('t5'), delta(), ended('t5')], opened)).toEqual([])
  })
})

/** A known gap's guard: a gap that hides a new failure would let a regression through. */
describe('expectGap', () => {
  const check = (gap: Parameters<typeof expectGap>[0], exit: Exit.Exit<unknown, unknown>) =>
    Exit.isSuccess(Effect.runSync(Effect.exit(expectGap(gap)(exit))))
  const why = 'known'
  /** A run that failed in the given parts, as `runScenario` reports it. */
  const run = (broke: string | null, violations: string[] = [], leaks: string[] = []) =>
    Exit.die(judge(broke, violations, leaks))

  it('passes while a passthrough scenario leaks exactly the listed lines, in any order', () => {
    expect(check({ why, leaks: ['banner: b', 'agent.text: a'] }, run(null, [], ['banner: b', 'agent.text: a']))).toBe(
      true,
    )
  })

  it('fails when a new leak joins the listed ones, or a listed one stops', () => {
    expect(check({ why, leaks: ['banner: b'] }, run(null, [], ['agent.text: a', 'banner: b']))).toBe(false)
    expect(check({ why, leaks: ['agent.text: a', 'banner: b'] }, run(null, [], ['banner: b']))).toBe(false)
  })

  it('never lets a leak hide behind `fails`, unless the gap lists it too', () => {
    expect(check({ why, fails: 'Provider text' }, run(null, [], ['banner: b']))).toBe(false)
    // The stream broke and the page leaked: a gap that lists only the stream must not pass.
    expect(check({ why, stream: ['never ended'] }, run(null, ['t1 on thr never ended'], ['banner: b']))).toBe(false)
    expect(
      check(
        { why, stream: ['never ended'], leaks: ['banner: b'] },
        run(null, ['t1 on thr never ended'], ['banner: b']),
      ),
    ).toBe(true)
  })

  it('judges each part on its own: a part the gap leaves out must be clean', () => {
    const both = run('Stop reaches the busy subagent', ['t1 ended twice'])
    expect(check({ why, fails: 'Stop reaches' }, both)).toBe(false)
    expect(check({ why, stream: ['ended twice'] }, both)).toBe(false)
    expect(check({ why, fails: 'Stop reaches', stream: ['ended twice'] }, both)).toBe(true)
    // A listed violation that no longer happens is stale.
    expect(check({ why, fails: 'Stop reaches', stream: ['ended twice'] }, run('Stop reaches the busy subagent'))).toBe(
      false,
    )
  })

  it('drops "never ended" when the scenario stopped early, and fails a gap that passes', () => {
    expect(check({ why, fails: 'Timed out' }, run('Timed out waiting', ['t1 on thr never ended']))).toBe(true)
    expect(check({ why, fails: 'anything' }, Exit.void)).toBe(false)
  })
})
