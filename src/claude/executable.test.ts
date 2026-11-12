import { describe, expect, it } from 'vitest'

import { packagedClaudeExecutable } from './executable'

const resolveTo = (path: string) => (id: string) => {
  expect(id).toBe('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
  return path
}

describe('packagedClaudeExecutable', () => {
  it('points a packaged app at the unpacked binary', () => {
    const archived = '/Applications/Docs.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    expect(packagedClaudeExecutable(resolveTo(archived), 'darwin', 'arm64')).toBe(
      '/Applications/Docs.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    )
  })

  it("leaves a source checkout to the SDK's own lookup", () => {
    expect(packagedClaudeExecutable(resolveTo('/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'), 'darwin', 'arm64')).toBeUndefined()
  })

  it('leaves a missing platform package to the SDK', () => {
    const missing = () => {
      throw new Error('Cannot find module')
    }
    expect(packagedClaudeExecutable(missing, 'darwin', 'arm64')).toBeUndefined()
  })
})
