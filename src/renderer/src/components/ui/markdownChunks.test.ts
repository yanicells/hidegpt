import { describe, expect, it } from 'vitest'

import { markdownChunks } from './markdownChunks'

describe('markdownChunks', () => {
  it('splits paragraphs and headings so earlier chunks stay stable', () => {
    expect(markdownChunks('# Title\n\nFirst para.\n\nSecond')).toEqual(['# Title\n', 'First para.\n', 'Second'])
  })

  it('keeps fenced code with blank lines together', () => {
    const text = 'Intro\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nAfter'
    expect(markdownChunks(text)).toEqual(['Intro\n', '```js\nconst a = 1\n\nconst b = 2\n```\n', 'After'])
  })

  it('keeps loose lists and nested content in one chunk', () => {
    const text = '1. One\n\n2. Two\n\n   more about two\n\nDone'
    expect(markdownChunks(text)).toEqual(['1. One\n\n2. Two\n\n   more about two\n', 'Done'])
  })

  it('leaves text with link definitions whole', () => {
    const text = 'See [docs][d].\n\n[d]: https://example.com'
    expect(markdownChunks(text)).toEqual([text])
  })
})
