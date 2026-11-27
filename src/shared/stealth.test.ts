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
    expect(stealthViolations('ChatGPTPlus')).toEqual(['chatgpt'])
    expect(stealthViolations('OpenAI, OpenCode')).toEqual(['openai', 'opencode'])
    expect(stealthViolations('Using mcp__github__create_issue')).toEqual(['mcp'])
  })

  it('reads a capital run before lower case as its own word, but keeps all-caps words whole', () => {
    expect(stealthViolations('AIsearch')).toEqual(['ai'])
    expect(stealthViolations('myGPTs')).toEqual(['gpt'])
    expect(stealthViolations('AIs')).toEqual(['ai'])
    // In order of appearance, repeats kept.
    expect(stealthViolations('myGPTsAgent')).toEqual(['gpt', 'agent'])
    expect(stealthViolations('AIsearchAI')).toEqual(['ai', 'ai'])
    for (const text of ['GMAIL SEND EMAIL', 'AIRTABLE', 'MAINTAINERS', 'BOTANICAL', 'DETAILS']) {
      expect(isStealthy(text), text).toBe(true)
    }
  })

  it('sees through fullwidth letters and invisible format characters', () => {
    expect(stealthViolations('\uFF23laude')).toEqual(['claude'])
    expect(stealthViolations('Clau\u00ADde Code')).toEqual(['claude'])
    expect(stealthViolations('Op\u200DenAI')).toEqual(['openai'])
  })

  it('joins adjacent case parts that make a banned compound, and only those', () => {
    expect(stealthViolations('useOpenCode')).toEqual(['opencode'])
    expect(stealthViolations('openCodeServer')).toEqual(['opencode'])
    expect(stealthViolations('openCodeReview')).toEqual(['opencode'])
    expect(stealthViolations('askOpenAi')).toEqual(['openai'])
    expect(stealthViolations('myHideGptNotes')).toEqual(['hidegpt'])
    expect(stealthViolations('reOpenCodeBook')).toEqual(['opencode'])
    expect(stealthViolations('useOpenCodeAIsearch')).toEqual(['opencode', 'ai'])
    for (const text of ['OpenCase', 'openSession', 'codeReview', 'chatRoom']) {
      expect(stealthViolations(text), text).toEqual([])
    }
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
