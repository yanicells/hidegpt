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

  it('splits words at underscores, digits and case changes', () => {
    expect(stealthViolations('gpt5 and GPT4o')).toEqual(['gpt', 'gpt'])
    expect(stealthViolations('ChatGPTPlus')).toEqual(['gpt'])
    expect(stealthViolations('OpenAI, OpenCode')).toEqual(['openai', 'opencode'])
    expect(stealthViolations('Using mcp__github__create_issue')).toEqual(['mcp'])
  })

  it('bans developer words a document editor would not say', () => {
    expect(stealthViolations('HideGPT CLI · SDK subagents via a provider')).toEqual([
      'hidegpt',
      'cli',
      'sdk',
      'subagent',
      'provider',
    ])
  })

  it('leaves words that only contain one alone', () => {
    for (const text of [
      'said',
      'maintain',
      'Botany notes',
      'tokenize',
      'Waiting for your response',
      'iPhone',
      'Clinic',
      'Providence',
    ]) {
      expect(isStealthy(text), text).toBe(true)
    }
  })
})
