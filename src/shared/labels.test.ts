import { describe, expect, it } from 'vitest'

import { accountLabel, avatarLetter, libraryName, PROVIDERS } from './labels'

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
