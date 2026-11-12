import { describe, expect, it } from 'vitest'

import { outlineEntries, sectionAt, sectionHeadings, type OutlineEntry } from './outline'

describe('document outline', () => {
  it('reads answer sections, skipping code fences and stripping markup', () => {
    const text = [
      '# **Light** reactions',
      '```md',
      '## not a heading',
      '```',
      'Body',
      '### The [Calvin](x) cycle #',
      '#### too deep',
    ].join('\n')
    expect(sectionHeadings(text)).toEqual(['Light reactions', 'The Calvin cycle'])
  })

  it('nests answer sections under their question', () => {
    const entries = outlineEntries([
      { kind: 'user', id: 'u1', text: 'How does photosynthesis work?' },
      { kind: 'agent', id: 'a1', text: '## Light reactions\nText\n## The Calvin cycle' },
    ])
    expect(entries.map((entry) => [entry.key, entry.level, entry.heading])).toEqual([
      ['u1', 1, undefined],
      ['a1-0', 2, 0],
      ['a1-1', 2, 1],
    ])
  })

  it('finds the section at the reading line', () => {
    const entries: OutlineEntry[] = ['u1', 'a1-0', 'u2'].map((key) => ({ key, blockId: key, text: key, level: 1 }))
    const at = (tops: Array<number | undefined>) => sectionAt(entries, tops, 100)?.key
    expect(at([-300, 40, 500])).toBe('a1-0')
    expect(at([-300, 100, 500])).toBe('a1-0')
    // Above every heading, the first section; a heading not on the page yet is skipped.
    expect(at([120, 400, 900])).toBe('u1')
    expect(at([-300, undefined, 90])).toBe('u2')
  })
})
