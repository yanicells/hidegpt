// Adapted from T3 Code (scripts/build-desktop-artifact.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { build } from 'electron-builder'

import { builderConfig, builderEnv, isPersonal, outputDir, wantsNotarizing, wantsSigning } from './builder-config.ts'
import { assertNoClaude, packagedArchives } from './shared-build-guard.ts'
import { verifyPreloadBundle } from './verify-preload-bundle.ts'

/**
 * `pnpm dist`: builds the app, checks the preload, packages a macOS `.dmg` and
 * `.zip`, and checks the shipped archive. With no env vars it makes an unsigned,
 * Claude-free build in `dist/`. `HIDEGPT_PERSONAL=1` keeps Claude and writes
 * `dist/personal/*-personal.dmg`; `CSC_LINK`/`CSC_NAME` sign it; the `APPLE_*`
 * notary vars notarize a signed build (see README, "Packaging").
 */

// electron-builder reads signing settings from process.env, so scrub it in place.
const env = builderEnv(process.env)
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
Object.assign(process.env, env)
const personal = isPersonal(env)

console.log(
  `Building Docs: ${personal ? 'personal (with Claude)' : 'shared (no Claude)'}, ` +
    `${wantsSigning(env) ? 'signed' : 'unsigned'}, ${wantsNotarizing(env) ? 'notarized' : 'not notarized'}`,
)

rmSync('out', { recursive: true, force: true })
execFileSync('pnpm', ['exec', 'electron-vite', 'build'], {
  stdio: 'inherit',
  env: { ...env, HIDEGPT_PERSONAL: personal ? '1' : '0' },
})

verifyPreloadBundle(readFileSync('out/preload/index.cjs', 'utf8'))

await build({ config: builderConfig(env), publish: 'never' })

if (!personal) {
  // Check what actually ships: the build-time flag should have left no Claude code in the app.
  const dir = outputDir(env)
  try {
    const archives = packagedArchives(dir)
    if (archives.length === 0) throw new Error(`No packaged app found in ${dir}/ to check`)
    archives.forEach(assertNoClaude)
  } catch (error) {
    // Leave nothing shareable behind; a personal build in dist/personal/ is kept.
    for (const entry of readdirSync(dir)) {
      if (entry !== 'personal') rmSync(join(dir, entry), { recursive: true, force: true })
    }
    throw error
  }
}
