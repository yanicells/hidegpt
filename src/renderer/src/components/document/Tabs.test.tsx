/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Block } from '../../../../shared/model'
import { outlineEntries } from './outline'
import { Tabs } from './Tabs'

// The browser calls the observers when something crosses the reading line (rows and
// headings) or the end comes into view; the tests call them by hand.
type Observer = {
  callback: IntersectionObserverCallback
  margin?: string
  threshold?: number | number[]
  targets: Set<Element>
}
let observers: Observer[] = []
// Heading tops on screen by text, and every element whose box was read.
let tops: Record<string, number> = {}
let measured: Element[] = []
const LINE = 100

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly self: Observer
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.self = { callback, margin: options?.rootMargin, threshold: options?.threshold, targets: new Set() }
        observers.push(this.self)
      }
      observe(target: Element) {
        this.self.targets.add(target)
      }
      unobserve(target: Element) {
        this.self.targets.delete(target)
      }
      disconnect() {
        this.self.targets.clear()
      }
    },
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    measured.push(this)
    return { top: tops[this.textContent ?? ''] ?? 0 } as DOMRect
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  observers = []
  tops = {}
  measured = []
})

const rows = () => observers.find((observer) => observer.margin !== undefined)!
const ending = () => observers.find((observer) => observer.margin === undefined)!

type Place = 'below' | 'straddling' | 'passed'
/** Reports where these rows or headings now sit against the reading line. */
function report(...places: Array<[Element, Place]>) {
  const records = places.map(([target, place]) => ({
    target,
    isIntersecting: place !== 'below',
    boundingClientRect: { bottom: place === 'passed' ? LINE - 10 : LINE + 50 },
    rootBounds: { bottom: LINE },
  }))
  act(() => rows().callback(records as unknown as IntersectionObserverEntry[], {} as IntersectionObserver))
}
const row = (id: string) => document.querySelector(`[data-block="${id}"]`)!
const heading = (text: string) => screen.getByRole('heading', { name: text })
const active = () => screen.getByRole('button', { current: 'location' }).textContent

const blocks: Block[] = [
  { kind: 'user', id: 'u1', text: 'Question' },
  { kind: 'agent', id: 'a1', text: '## Light\nText\n## Dark' },
  // A heading-less answer: no outline entries of its own.
  { kind: 'agent', id: 'c1', text: 'Plain answer' },
  { kind: 'user', id: 'u2', text: 'Next' },
  { kind: 'agent', id: 'a2', text: '## Far' },
]

/** The canvas with these blocks' rows; `rendered` leaves later rows to land after mount. */
function mount(rendered = blocks.length) {
  render(
    <div className="workspace">
      <Tabs entries={outlineEntries(blocks)} onNew={() => {}} onJump={() => {}} />
      <div className="paper-flow">
        {blocks.slice(0, rendered).map((block) => (
          <div key={block.id} data-block={block.id}>
            {block.kind === 'agent' ? (
              block.text
                .split('\n')
                .map((line) =>
                  line.startsWith('## ') ? <h2 key={line}>{line.slice(3)}</h2> : <p key={line}>{line}</p>,
                )
            ) : (
              <h1>{block.kind === 'user' ? block.text : ''}</h1>
            )}
          </div>
        ))}
      </div>
      <div className="paper-end" />
    </div>,
  )
}

describe('document tabs active item', () => {
  it('follows the section at the reading line as you scroll', () => {
    mount()
    // Threshold 1 reports a row's bottom crossing the line, which ends its straddle.
    expect([rows().threshold].flat()).toContain(1)
    report([row('u1'), 'below'], [row('a1'), 'below'], [row('c1'), 'below'], [row('u2'), 'below'])
    expect(active()).toBe('Question')
    tops = { Light: 60, Dark: 500 }
    report([row('u1'), 'passed'], [row('a1'), 'straddling'])
    expect(active()).toBe('Light')
    // A heading crossing inside a long answer reports too.
    tops = { Light: -400, Dark: 40 }
    report([heading('Dark'), 'straddling'])
    expect(active()).toBe('Dark')
    report([row('a1'), 'passed'], [row('c1'), 'passed'], [row('u2'), 'straddling'])
    expect(active()).toBe('Next')
  })

  it('measures and watches headings only in the row straddling the line', () => {
    mount()
    tops = { Light: 60, Dark: 500 }
    report([row('u1'), 'passed'], [row('a1'), 'straddling'])
    expect(active()).toBe('Light')
    // Off-screen rows (skipped by content-visibility) are never laid out for a box.
    expect(measured.length).toBeGreaterThan(0)
    expect(measured.every((element) => row('a1').contains(element))).toBe(true)
    expect(rows().targets.has(heading('Dark'))).toBe(true)
    expect(rows().targets.has(heading('Far'))).toBe(false)
    // Moving on to the next question stops watching the last row's headings.
    report([row('a1'), 'passed'], [row('c1'), 'passed'], [row('u2'), 'straddling'])
    expect(rows().targets.has(heading('Dark'))).toBe(false)
  })

  it('measures nothing while the line is in a row without headings', () => {
    mount()
    report([row('u1'), 'passed'], [row('a1'), 'passed'], [row('c1'), 'straddling'])
    // Still the section of the answer above; its headings may be skipped, so none are read or watched.
    expect(active()).toBe('Dark')
    expect(measured).toEqual([])
    expect([...rows().targets].some((target) => target.matches('h1, h2, h3'))).toBe(false)
  })

  it('observes rows that land after the panel mounts', async () => {
    mount(3)
    const flow = document.querySelector('.paper-flow')!
    const late = document.createElement('div')
    late.dataset.block = 'u2'
    late.textContent = 'Next'
    flow.append(late)
    await waitFor(() => expect(rows().targets.has(late)).toBe(true))
    report([row('u1'), 'passed'], [row('a1'), 'passed'], [row('c1'), 'passed'], [late, 'straddling'])
    expect(active()).toBe('Next')
  })

  it('makes a short last section active once the end is on screen', () => {
    mount()
    tops = { Far: 300 }
    report(
      [row('u1'), 'passed'],
      [row('a1'), 'passed'],
      [row('c1'), 'passed'],
      [row('u2'), 'passed'],
      [row('a2'), 'straddling'],
    )
    expect(active()).toBe('Next')
    act(() => ending().callback([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver))
    expect(active()).toBe('Far')
  })

  it('keeps a clicked item active until you scroll', () => {
    mount()
    tops = { Light: 60, Dark: 500 }
    report([row('u1'), 'passed'], [row('a1'), 'straddling'])
    fireEvent.click(screen.getByTestId('outline-a1-1'))
    report([row('a1'), 'straddling'])
    expect(active()).toBe('Dark')
    fireEvent.wheel(window)
    expect(active()).toBe('Light')
  })
})
