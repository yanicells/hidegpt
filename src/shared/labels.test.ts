import { describe, expect, it } from 'vitest'

import { accountLabel, avatarLetter, libraryName, PROVIDERS, providersFor, windowTitle } from './labels'

describe('account labels', () => {
  it('shows an address as it is', () => {
    const account = { kind: 'chatgpt' as const, label: 'yan@school.edu' }
    expect(accountLabel(account)).toBe('yan@school.edu')
    expect(avatarLetter(account)).toBe('Y')
  })

  it('never shows a provider-named fallback', () => {
    for (const label of ['ChatGPT', 'Claude Code', 'API key', '']) {
      expect(accountLabel({ kind: 'other', label })).toBe('Google Account')
    }
    expect(accountLabel(null)).toBe('Sign in')
    expect(avatarLetter(null)).toBe('?')
  })

  it('names every library like a Google profile', () => {
    expect(PROVIDERS.map(libraryName)).toEqual(['Personal', 'Work', 'School'])
  })
})

describe('providersFor', () => {
  it('leaves Claude out of a shared build', () => {
    expect(providersFor(false)).toEqual(['codex', 'opencode'])
  })

  it('lists every library in a personal build', () => {
    expect(providersFor(true)).toEqual(['codex', 'opencode', 'claude'])
  })

  it('follows the build flag (tests build as personal)', () => {
    expect(PROVIDERS).toEqual(providersFor(true))
  })
})

describe('windowTitle', () => {
  const doc = { kind: 'doc', threadId: 'thr_1' } as const

  it('reads like a Google Docs tab', () => {
    expect(windowTitle({ kind: 'home' }, 'Essay')).toBe('Google Docs')
    expect(windowTitle(doc, ' Essay on photosynthesis ')).toBe('Essay on photosynthesis - Google Docs')
  })

  it('names a document without a title "Untitled document"', () => {
    expect(windowTitle(doc, '  ')).toBe('Untitled document - Google Docs')
  })
})
