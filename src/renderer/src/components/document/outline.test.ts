import { describe, expect, it } from 'vitest'

import { outlineEntries, sectionHeadings } from './outline'

describe('document outline', () => {
  it('reads answer sections, skipping code fences and stripping markup', () => {
    const text = ['# **Light** reactions', '```md', '## not a heading', '```', 'Body', '### The [Calvin](x) cycle #', '#### too deep'].join('\n')
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
})
