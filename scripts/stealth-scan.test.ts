import { describe, expect, it } from 'vitest'

import { appLeaks, bundleHits, checkHits, readAllowList, type BundleFile } from './stealth-scan'

const js = (source: string): BundleFile => ({ part: 'renderer', name: 'index.js', source })

describe('bundleHits', () => {
  it('flags a vendor word in any string, and a banned word only in prose', () => {
    const hits = bundleHits([
      js(`const a = "Powered by Claude", b = \`Ask the assistant\`, c = "agent", d = "codex", e = "model-row"`),
    ])
    expect(hits.map(({ literal }) => literal)).toEqual(['Powered by Claude', 'Ask the assistant', 'codex'])
  })

  it('lets a code string hold a vendor name inside an identifier, but not prose', () => {
    const hits = bundleHits([js(`const a = "codexAdapter", b = "useOpenAI", c = "Ask ChatGPTPlus", d = "Docs GPT5"`)])
    expect(hits.map(({ literal }) => literal)).toEqual(['Ask ChatGPTPlus', 'Docs GPT5'])
  })

  it('finds strings after a regex that holds a quote', () => {
    expect(bundleHits([js(`const r = /"'/g; const s = "Claude"`)]).map(({ literal }) => literal)).toEqual(['Claude'])
  })

  it('reads CSS strings and HTML text', () => {
    const files: BundleFile[] = [
      { part: 'renderer', name: 'index.css', source: `a::after{content:"OpenAI"}` },
      { part: 'renderer', name: 'index.html', source: `<title>Docs</title><p title="Ask the bot">x</p>` },
    ]
    expect(bundleHits(files).map(({ literal }) => literal)).toEqual(['OpenAI', 'Ask the bot'])
  })
})

describe('checkHits', () => {
  const allowed = [{ part: 'renderer', literal: 'codex', count: 2, reason: 'id' }] as const

  it('passes allowed literals at their count', () => {
    expect(checkHits(bundleHits([js(`f("codex", "codex")`)]), allowed)).toEqual([])
  })

  it('fails a new literal, one seen more often than allowed, and a count that should shrink', () => {
    expect(checkHits(bundleHits([js(`f("Powered by Claude", "codex", "codex")`)]), allowed)).toEqual([
      'renderer: "Powered by Claude" has Claude (1x)',
    ])
    expect(checkHits(bundleHits([js(`f("codex", "codex", "codex")`)]), allowed)).toEqual([
      'renderer: "codex" appears 3x, allowed 2x',
    ])
    expect(checkHits(bundleHits([js(`f("codex")`)]), allowed)).toEqual([
      'renderer: "codex" appears 1x; lower its count in stealth-allow.json to 1',
    ])
  })

  it('starts the allow-list at 35 occurrences or fewer, each with a reason', () => {
    const { bundle } = readAllowList()
    expect(bundle.reduce((sum, entry) => sum + entry.count, 0)).toBeLessThanOrEqual(35)
    for (const entry of bundle) expect(entry.reason.length).toBeGreaterThan(10)
  })
})

describe('appLeaks', () => {
  const sdk = { path: 'app.asar:node_modules/@anthropic-ai/claude-agent-sdk', reason: 'loaded at run time' }

  it('allows exactly the listed package and the folders leading to it', () => {
    const paths = [
      'Contents/MacOS/Docs',
      'app.asar:out/main/chunk-abc.js',
      'app.asar:node_modules/@anthropic-ai',
      'app.asar:node_modules/@anthropic-ai/claude-agent-sdk',
      'app.asar:node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    ]
    expect(appLeaks(paths, ['Docs'], [sdk])).toEqual([])
  })

  it('still fails every other vendor-named path, and plist strings', () => {
    const paths = [
      'app.asar:node_modules/@anthropic-ai/claude-agent-sdk-extra/index.js',
      'app.asar:node_modules/@anthropic-ai/other/index.js',
      'app.asar:node_modules/openai/index.js',
      'Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
      'Contents/Resources/claude',
      // Paths go through the shared gate, so a vendor name inside a longer name fails too.
      'app.asar:out/main/CodexAdapter-abc.js',
      'Contents/Frameworks/ClaudeHelper.app',
    ]
    expect(appLeaks(paths, ['Claude Helper'], [sdk])).toEqual([...paths, 'Info.plist: "Claude Helper"'])
  })

  it('keeps the real allow-list that narrow', () => {
    const { packaged } = readAllowList()
    const others = [
      'app.asar:node_modules/@anthropic-ai/other/index.js',
      'app.asar:node_modules/@anthropic-ai/claude-agent-sdk-extra',
      'Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
      'Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/other',
      'Contents/Frameworks/Claude Helper.app',
    ]
    expect(appLeaks(others, [], packaged)).toEqual(others)
  })
})
