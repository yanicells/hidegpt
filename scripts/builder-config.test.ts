import { describe, expect, it } from 'vitest'

import { builderConfig } from './builder-config.ts'

const NOTARY = { APPLE_API_KEY: '/keys/AuthKey.p8', APPLE_API_KEY_ID: 'KEYID', APPLE_API_ISSUER: 'issuer' }

describe('builderConfig', () => {
  it('makes an ad-hoc signed, un-notarized build with no env vars', () => {
    const { mac } = builderConfig({})
    expect(mac).toMatchObject({ identity: '-', hardenedRuntime: false, notarize: false })
  })

  it('signs with the hardened runtime only when a certificate is set', () => {
    const { mac } = builderConfig({ CSC_LINK: '/certs/developer-id.p12' })
    expect(mac).not.toHaveProperty('identity')
    expect(mac).toMatchObject({ hardenedRuntime: true, notarize: false })
  })

  it('notarizes only a signed build with complete notary credentials', () => {
    expect(builderConfig({ CSC_NAME: 'Developer ID Application: Someone', ...NOTARY }).mac?.notarize).toBe(true)
    expect(builderConfig(NOTARY).mac?.notarize).toBe(false)
    expect(builderConfig({ CSC_NAME: 'Developer ID Application: Someone', APPLE_API_KEY: '/keys/AuthKey.p8' }).mac?.notarize).toBe(false)
  })

  it('treats empty or blank variables as unset', () => {
    expect(builderConfig({ CSC_LINK: '', CSC_NAME: '  ' }).mac).toMatchObject({ identity: '-', hardenedRuntime: false })
  })

  it('ships no node_modules and no dependency list in a shared build', () => {
    const config = builderConfig({ HIDEGPT_PERSONAL: '0' })
    expect(config.files).toEqual(['out/**/*', 'package.json', '!node_modules/**/*'])
    expect(config.asarUnpack).toEqual([])
    expect(config.extraMetadata).toMatchObject({ dependencies: null })
  })

  it('ships only the Claude SDK, its binary unpacked, in a personal build', () => {
    const config = builderConfig({ HIDEGPT_PERSONAL: '1' })
    expect(config.files).toContain('node_modules/@anthropic-ai/claude-agent-sdk/**/*')
    expect(config.asarUnpack).toEqual(['node_modules/@anthropic-ai/claude-agent-sdk-*/**/*'])
    expect(config.extraMetadata).not.toHaveProperty('dependencies')
  })

  it('names everything a person sees "Docs"', () => {
    const config = builderConfig({})
    expect(config).toMatchObject({ productName: 'Docs', extraMetadata: { name: 'docs', productName: 'Docs' } })
    expect(JSON.stringify(config)).not.toMatch(/gpt|claude-code|openai|\bai\b/i)
  })
})
