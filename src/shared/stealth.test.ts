import { describe, expect, it } from 'vitest'

import { isStealthy, stealthViolations } from './stealth'

describe('stealth gate', () => {
  it('matches banned words whole, in any case, plural included', () => {
    expect(stealthViolations('Ask AI')).toEqual(['ai'])
    expect(stealthViolations('Agent · search')).toEqual(['agent'])
    expect(stealthViolations('GPT-5 models')).toEqual(['gpt', 'model'])
    expect(stealthViolations('claude_ai')).toEqual(['claude', 'ai'])
    expect(stealthViolations('The assistant needs input')).toEqual(['assistant'])
  })

  it('leaves words that only contain one alone', () => {
    for (const text of ['said', 'maintain', 'Botany notes', 'tokenize', 'Waiting for your response']) {
      expect(isStealthy(text), text).toBe(true)
    }
  })
})
