import { describe, expect, it } from 'vitest'

import { claudeLeaks } from './shared-build-guard.ts'

const files: Record<string, string> = {
  'package.json': '{"name":"docs"}',
  'out/main/index.js': 'await import("./app.js")',
  'out/main/app.js': 'const hint = "run `claude` in a terminal"; const PROVIDERS = ["codex", "opencode"]',
  'out/renderer/index.html': '<title>Docs</title>',
}
const leaks = (extra: Record<string, string>) => {
  const all = { ...files, ...extra }
  return claudeLeaks(Object.keys(all), (path) => all[path] ?? '')
}

describe('claudeLeaks', () => {
  it('passes a shared build that only names Claude in labels', () => {
    expect(leaks({})).toEqual([])
  })

  it('flags any node_modules or Anthropic package', () => {
    expect(leaks({ 'node_modules/react/index.js': '', 'node_modules/@anthropic-ai/sdk/package.json': '{}' })).toEqual([
      'node_modules/react/index.js',
      'node_modules/@anthropic-ai/sdk/package.json',
    ])
  })

  it('flags a chunk named after Claude', () => {
    expect(leaks({ 'out/main/ClaudeAdapter-abc.js': '' })).toEqual(['out/main/ClaudeAdapter-abc.js'])
  })

  it('flags Claude code inlined into another chunk', () => {
    expect(leaks({ 'out/main/app-x.js': 'import("@anthropic-ai/claude-agent-sdk")' })).toEqual(['out/main/app-x.js'])
    expect(leaks({ 'out/main/demo-x.js': 'function makeDemoClaude() {}' })).toEqual(['out/main/demo-x.js'])
  })
})
