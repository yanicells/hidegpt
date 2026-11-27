/** @vitest-environment jsdom */

import { cleanup, render } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { Block } from '../../../../shared/model'
import { loadMarkdown } from '../ui/loadMarkdown'
import { BlockView } from './BlockView'

beforeAll(async () => {
  await loadMarkdown()
})
afterEach(cleanup)

const answer = (text: string): Block => ({ kind: 'agent', id: 'a1', text })

describe('BlockView streaming', () => {
  it('shows finished lines with the cursor on the writing line below, then the whole answer', () => {
    const { container, rerender } = render(<BlockView block={answer('Intro.\n\n1. State the')} streaming />)
    expect(container.querySelector('.doc-body')?.textContent).toBe('Intro.')
    expect(container.querySelector('.writing-line .caret')).not.toBeNull()

    rerender(<BlockView block={answer('Intro.\n\n1. State the idea.')} streaming={false} />)
    expect(container.querySelector('li')?.textContent).toBe('State the idea.')
    expect(container.querySelector('.writing-line, .streaming')).toBeNull()
  })

  it('keeps the writing line until the last line lands in it, so the page never moves up and back', () => {
    const commits: Array<{ text: string; writing: boolean }> = []
    let container: HTMLElement | null = null
    const record = () => {
      if (!container) return
      commits.push({
        text: container.querySelector('.doc-body')?.textContent ?? '',
        writing: container.querySelector('.writing-line') !== null,
      })
    }
    const view = (block: Block, streaming: boolean) => (
      <Profiler id="answer" onRender={record}>
        <BlockView block={block} streaming={streaming} />
      </Profiler>
    )
    const rendered = render(view(answer('Intro.\n\nThe end'), true))
    container = rendered.container
    commits.length = 0

    rendered.rerender(view(answer('Intro.\n\nThe end.'), false))
    expect(commits.at(-1)).toEqual({ text: 'Intro.The end.', writing: false })
    expect(commits.filter((commit) => !commit.writing && commit.text === 'Intro.')).toEqual([])
  })
})
