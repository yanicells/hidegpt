import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The Claude Code binary's file name in a packaged personal build. The build
 * copies it out of the SDK's package into `Contents/Resources/` under this
 * name (scripts/builder-config.ts), so no file in the bundle has a vendor name.
 */
export const PACKAGED_BINARY_NAME = 'Docs Helper'

/**
 * Where a packaged personal build keeps the Claude Code binary. Returns
 * undefined when it isn't there (running from source), which leaves the SDK
 * its own lookup of its platform package.
 */
export function packagedClaudeExecutable(
  resourcesPath: string | undefined = process.resourcesPath,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (!resourcesPath) return undefined
  const path = join(resourcesPath, PACKAGED_BINARY_NAME)
  return exists(path) ? path : undefined
}
