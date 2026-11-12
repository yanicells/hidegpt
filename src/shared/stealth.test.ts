import { describe, expect, it } from 'vitest'

import { displayServerName, skillDescription, skillLabel } from './labels'
import { isStealthy, neutralizeName, neutralizeSentence, stealthViolations, stripVendorWords } from './stealth'

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
    for (const text of ['gpt5 notes', 'ClaudeCode session', 'Claude3 failed', 'OpenAIError: 401', 'claudeHelper']) {
      expect(isStealthy(text), text).toBe(false)
    }
    expect(stealthViolations('GPTResearcher, AgentMail')).toEqual(['gpt', 'agent'])
  })

  it('reads a capital run before lower case as its own word, but keeps all-caps words whole', () => {
    expect(stealthViolations('AIsearch')).toEqual(['ai'])
    expect(stealthViolations('myGPTs')).toEqual(['gpt'])
    expect(stealthViolations('AIs')).toEqual(['ai'])
    for (const text of ['GMAIL SEND EMAIL', 'AIRTABLE', 'MAINTAINERS', 'BOTANICAL', 'DETAILS']) {
      expect(isStealthy(text), text).toBe(true)
    }
  })

  it('sees through fullwidth letters and invisible format characters', () => {
    expect(stealthViolations('\uFF23laude')).toEqual(['claude'])
    expect(stealthViolations('Clau\u00ADde Code')).toEqual(['claude'])
    expect(stealthViolations('Op\u200DenAI')).toEqual(['openai'])
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
      'Ask Gemini',
    ]) {
      expect(isStealthy(text), text).toBe(true)
    }
  })

  it('gives the same answer however often and in whatever order it is asked', () => {
    expect(isStealthy('an agent')).toBe(false)
    expect(stealthViolations('an agent')).toEqual(['agent'])
    expect(neutralizeSentence('The assistant stopped.')).toBe('Docs stopped.')
    expect(neutralizeSentence('The assistant stopped.')).toBe('Docs stopped.')
    expect(stealthViolations('an agent')).toEqual(['agent'])
  })
})

describe('neutralizeSentence', () => {
  it('names Docs instead of a vendor or "the assistant"', () => {
    expect(neutralizeSentence('Claude is still answering.')).toBe('Docs is still answering.')
    expect(neutralizeSentence('Claude Code stopped.')).toBe('Docs stopped.')
    expect(neutralizeSentence('The assistant needs input')).toBe('Docs needs input')
    expect(neutralizeSentence('The model provider failed.')).toBe('Docs failed.')
  })

  it('replaces the whole piece a vendor name is part of', () => {
    expect(neutralizeSentence('GPT-5 is unavailable.')).toBe('Docs is unavailable.')
    expect(neutralizeSentence('Open claude.ai, then ChatGPT’s settings.')).toBe('Open Docs, then Docs settings.')
  })

  it('leaves a sentence without vendor names alone', () => {
    const text = 'A business model canvas for an AI class'
    expect(neutralizeSentence(text)).toBe(text)
  })
})

describe('neutralizeName', () => {
  it.each([
    ['claude-in-chrome', 'In Chrome'],
    ['openai-docs', 'Docs'],
    ['codex:rescue', 'Rescue'],
    ['github', 'Github'],
    ['claude_ai_Notion', 'Notion'],
    ['frontend-design', 'Frontend Design'],
    ['agent-tools', 'Tools'],
    ['list_models', 'List'],
    ['slack-bot', 'Slack'],
    ['agent-sdk-dev', 'Dev'],
    ['anthropic-skills:docx', 'Docx'],
    ['codex:gpt-5-4-prompting', 'Prompting'],
    ['week-3-notes', 'Week 3 Notes'],
  ])('%s reads %s', (name, label) => {
    expect(neutralizeName(name, 'fallback')).toBe(label)
  })

  it('falls back when nothing but banned words is left', () => {
    expect(neutralizeName('claude', 'A connected app')).toBe('A connected app')
    expect(neutralizeName('mcp-agent', 'A connected app')).toBe('A connected app')
    expect(neutralizeName('', 'A connected app')).toBe('A connected app')
  })

  it('never returns a banned word', () => {
    for (const name of [
      'claude-in-chrome',
      'openai-docs',
      'codex:rescue',
      'chatgpt_apps',
      'mcp-server-copilot',
      'agent-tools',
      'get_tokens',
      'ask_llm',
      'model-context',
      'prompt-library',
      'ChatGPTPlus',
    ]) {
      expect(stealthViolations(neutralizeName(name, 'x')), name).toEqual([])
    }
  })
})

describe('stripVendorWords', () => {
  it('drops each piece that names a vendor, and only those', () => {
    expect(stripVendorWords('Codex notes on the model', 'Untitled')).toBe('notes on the model')
    expect(stripVendorWords('Chat with GPT-5', 'Untitled')).toBe('Chat with')
    expect(stripVendorWords('claude.ai export', 'Untitled')).toBe('export')
    expect(stripVendorWords('Claude', 'Untitled document')).toBe('Untitled document')
  })

  it('returns a title without vendor names as the same string', () => {
    const title = 'Essay on AI ethics'
    expect(stripVendorWords(title, 'Untitled')).toBe(title)
  })
})

describe('display labels', () => {
  it('names connected apps and skills without banned words', () => {
    expect(displayServerName('claude-in-chrome')).toBe('In Chrome')
    expect(displayServerName('openai')).toBe('A connected app')
    expect(skillLabel('codex:rescue')).toBe('Rescue')
  })

  it('shows a skill description only when it reads as Docs', () => {
    expect(skillDescription('Turn rough notes into a clean outline.')).toBe('Turn rough notes into a clean outline.')
    expect(skillDescription('Rewrite text so it sounds less like Claude wrote it.')).toBe(
      'Rewrite text so it sounds less like Docs wrote it.',
    )
    for (const text of [
      'Reference for the Claude API / Anthropic SDK — model ids, pricing, streaming.',
      'Ask the agent to review your draft.',
      'Uses MCP tools to search your notes.',
      '',
    ]) {
      expect(skillDescription(text), text).toBeNull()
    }
  })
})
