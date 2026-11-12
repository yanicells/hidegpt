/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { emptySnapshot, type ApprovalBlock, type Block } from '../../shared/model'
import { stealthViolations } from '../../shared/stealth'
import { BlockView } from './components/document/BlockView'
import { Banners } from './components/layout/Banners'

/**
 * The renderer's own wording for blocks and banners (verbs, button labels,
 * placeholders, banner sentences) through the stealth gate. The content here
 * is neutral, so any hit is a word the renderer wrote. `present.test.ts`
 * covers what main writes.
 */

afterEach(cleanup)

/** Visible text plus the attributes a screen reader or a hover shows. */
function wording(): string {
  const attributes = Array.from(document.querySelectorAll('[aria-label], [placeholder], [title], [alt]')).flatMap(
    (node) => ['aria-label', 'placeholder', 'title', 'alt'].map((name) => node.getAttribute(name) ?? ''),
  )
  return [document.body.textContent ?? '', ...attributes].join('\n')
}

const approval = (suggestion: ApprovalBlock['suggestion'], pending = false): ApprovalBlock => ({
  kind: 'approval',
  id: `ap_${suggestion}`,
  suggestion,
  title: 'Apply changes?',
  body: 'notes.md',
  fields: [{ id: 'f1', label: 'Folder' }],
  questions: [
    { id: 'q1', question: 'Which file?', options: ['notes.md', 'todo.md'], allowText: true },
    { id: 'q2', question: 'Why?', options: [], allowText: true },
  ],
  resolved: null,
  pending,
})

describe('renderer wording', () => {
  it('suggestion cards and callouts say nothing a model would', () => {
    const blocks: Block[] = [
      { kind: 'callout', id: 'c1', title: 'Ran a command', body: 'ls' },
      approval('add'),
      approval('replace'),
      approval('format', true),
      approval('question'),
    ]
    render(
      <>
        {blocks.map((block) => (
          <BlockView key={block.id} block={block} streaming />
        ))}
      </>,
    )
    expect(screen.getAllByLabelText('Accept suggestion')).toHaveLength(4)
    expect(stealthViolations(wording())).toEqual([])
  })

  it('sign-in and error banners say nothing a model would', () => {
    const snap = {
      ...emptySnapshot('/tmp', 'codex'),
      status: 'ready' as const,
      requiresAuth: true,
      loginUrl: 'https://auth.example/login',
      error: 'Docs lost its connection. Try again in a moment.',
    }
    render(<Banners snap={snap} />)
    fireEvent.click(screen.getByText('Details'))
    expect(screen.getByTestId('auth-banner')).toBeTruthy()
    expect(screen.getByTestId('login-url')).toBeTruthy()
    expect(stealthViolations(wording())).toEqual([])
  })
})
