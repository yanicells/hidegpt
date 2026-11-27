import { describe, expect, it } from 'vitest'

import { builderConfig, builderEnv } from './builder-config.ts'

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
    expect(
      builderConfig({ CSC_NAME: 'Developer ID Application: Someone', APPLE_API_KEY: '/keys/AuthKey.p8' }).mac?.notarize,
    ).toBe(false)
  })

  it('treats empty or blank variables as unset', () => {
    expect(builderConfig({ CSC_LINK: '', CSC_NAME: '  ' }).mac).toMatchObject({ identity: '-', hardenedRuntime: false })
  })

  it('makes only a .dmg, with no update files, and no one-time-code popup over the composer', () => {
    const config = builderConfig({})
    expect(config.mac?.target).toEqual(['dmg'])
    expect(config.dmg).toMatchObject({ writeUpdateInfo: false })
    expect(config.mac?.extendInfo).toMatchObject({ NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true })
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
    expect(config.files).toContain(
      '!node_modules/@anthropic-ai/claude-agent-sdk/{bridge.mjs,browser-sdk.js,core*.mjs,*.d.ts}',
    )
    expect(config.asarUnpack).toEqual(['node_modules/@anthropic-ai/claude-agent-sdk-*/**/*'])
    expect(config.extraMetadata).not.toHaveProperty('dependencies')
  })

  it('names everything a person sees "Docs"', () => {
    const config = builderConfig({})
    expect(config).toMatchObject({
      productName: 'Docs',
      extraMetadata: { name: 'docs', productName: 'Docs', engines: null, packageManager: null },
    })
    expect(JSON.stringify(config)).not.toMatch(/gpt|claude-code|openai|\bai\b/i)
  })
})

describe('personal builds', () => {
  it('get their own folder and name, so a shared build is never mistaken for one', () => {
    const shared = builderConfig({})
    const personal = builderConfig({ HIDEGPT_PERSONAL: '1' })
    expect(shared).toMatchObject({ artifactName: 'Docs-${version}-${arch}.${ext}', directories: { output: 'dist' } })
    expect(personal).toMatchObject({
      artifactName: 'Docs-${version}-${arch}-personal.${ext}',
      directories: { output: 'dist/personal' },
    })
  })
})

describe('builderEnv', () => {
  const SIGNING = { CSC_LINK: '/certs/developer-id.p12', CSC_KEY_PASSWORD: 'secret', ...NOTARY }

  it('drops every signing variable from an unsigned build and stops keychain discovery', () => {
    const env = builderEnv({ PATH: '/usr/bin', CSC_LINK: '  ', CSC_KEY_PASSWORD: 'secret', ...NOTARY })
    expect(env).toEqual({ PATH: '/usr/bin', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
  })

  it('keeps the signing variables of a signed build, minus blank ones', () => {
    const env = builderEnv({ ...SIGNING, APPLE_TEAM_ID: ' ' })
    expect(env).toEqual(SIGNING)
  })
})
