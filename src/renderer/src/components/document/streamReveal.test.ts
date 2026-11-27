import { describe, expect, it } from 'vitest'

import { revealedText } from './streamReveal'

describe('revealedText', () => {
  it('shows whole lines only', () => {
    expect(revealedText('A clear answer starts')).toBe('')
    expect(revealedText('Intro.\n\n1. State the idea.\n2. Give an')).toBe('Intro.\n\n1. State the idea.\n')
    expect(revealedText('```\nfor x in y; do\n  check')).toBe('```\nfor x in y; do\n')
  })

  it('holds a table until a line after it arrives, then shows it whole', () => {
    const table = 'Results:\n\n| Week | Score |\n| --- | --- |\n| 1 | 9 |\n'
    expect(revealedText('Results:\n\n| Week | Score |\n')).toBe('Results:\n\n')
    expect(revealedText(table)).toBe('Results:\n\n')
    expect(revealedText(`${table}\nNext`)).toBe(`${table}\n`)
    expect(revealedText('| Week |\n')).toBe('')
  })
})
