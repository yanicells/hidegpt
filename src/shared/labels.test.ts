import { describe, expect, it } from 'vitest'

import { PROVIDERS, providersFor } from './labels'

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
