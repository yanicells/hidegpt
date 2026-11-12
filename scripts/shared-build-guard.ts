import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { extractFile, listPackage } from '@electron/asar'

/**
 * Strings only Claude code carries: the SDK's package name, and identifiers from
 * `src/claude/` (the adapter's SDK options and session calls, the fake's factory)
 * that survive bundling. The provider id and its labels ("Claude") are allowed.
 */
const CLAUDE_MARKERS = [
  'claude-agent-sdk',
  'pathToClaudeCodeExecutable',
  'includePartialMessages',
  'getSessionMessages',
  'makeDemoClaude',
]

const isScript = (path: string) => /\.(c|m)?js$/.test(path)

/**
 * What in a shared build's app archive is, or carries, Claude code: any
 * `node_modules` (a shared build needs none), anything under `@anthropic-ai` or
 * named after Claude, and any script with a Claude marker inlined into it.
 */
export function claudeLeaks(paths: ReadonlyArray<string>, read: (path: string) => string): ReadonlyArray<string> {
  return paths.filter((path) => {
    if (path.includes('node_modules') || path.includes('@anthropic-ai') || /claude/i.test(path)) return true
    if (!isScript(path)) return false
    const source = read(path)
    return CLAUDE_MARKERS.some((marker) => source.includes(marker))
  })
}

/** The `app.asar` of every packaged app under `outputDir` (e.g. `dist/mac-arm64/Docs.app`). */
export function packagedArchives(outputDir: string): ReadonlyArray<string> {
  return readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .flatMap((entry) =>
      readdirSync(join(outputDir, entry.name))
        .filter((name) => name.endsWith('.app'))
        .map((app) => join(outputDir, entry.name, app, 'Contents/Resources/app.asar')),
    )
}

/** Throws if a shipped archive of a shared build has Claude in it, or a Claude binary beside it. */
export function assertNoClaude(archive: string): void {
  const leaks = [
    ...claudeLeaks(
      listPackage(archive, { isPack: false }).map((path) => path.replace(/^[/\\]/, '')),
      (path) => extractFile(archive, path).toString('utf8'),
    ),
    ...(existsSync(`${archive}.unpacked`) ? [`${archive}.unpacked`] : []),
  ]
  if (leaks.length > 0) throw new Error(`A shared build contains Claude code:\n  ${leaks.join('\n  ')}`)
}
