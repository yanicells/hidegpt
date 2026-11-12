import { createRequire } from 'node:module'
import { sep } from 'node:path'

const archived = `app.asar${sep}`
const unpacked = `app.asar.unpacked${sep}`

/**
 * Where a packaged app keeps the Claude Code binary. The SDK finds the binary in
 * its platform package, but inside a packaged app that path points into
 * `app.asar`, which can't be spawned; electron-builder unpacks the package next
 * to it (`asarUnpack`), so the path is rewritten to there. Returns undefined
 * when running from source, where the SDK's own lookup works.
 */
export function packagedClaudeExecutable(
  resolve: (id: string) => string = createRequire(import.meta.url).resolve,
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  try {
    const path = resolve(
      `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${platform === 'win32' ? '.exe' : ''}`,
    )
    return path.includes(archived) ? path.replace(archived, unpacked) : undefined
  } catch {
    return undefined
  }
}
