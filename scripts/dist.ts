// Adapted from T3 Code (scripts/build-desktop-artifact.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { build } from 'electron-builder'

import {
  builderConfig,
  builderEnv,
  isPersonal,
  outputDir,
  SIGNING_VARS,
  wantsNotarizing,
  wantsSigning,
} from './builder-config.ts'
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

/** Empties the output folder, keeping a personal build that sits inside a shared one's folder. */
function clearOutput(dir: string): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry !== 'personal') rmSync(join(dir, entry), { recursive: true, force: true })
  }
}

// The app build never signs, so it gets no signing credentials.
const viteEnv: Record<string, string> = { ...env, HIDEGPT_PERSONAL: personal ? '1' : '0' }
for (const key of SIGNING_VARS) delete viteEnv[key]

rmSync('out', { recursive: true, force: true })
execFileSync('pnpm', ['exec', 'electron-vite', 'build'], { stdio: 'inherit', env: viteEnv })

verifyPreloadBundle(readFileSync('out/preload/index.cjs', 'utf8'))

// Stale artifacts from an earlier run would otherwise sit beside the new ones, unchecked.
const dir = outputDir(env)
clearOutput(dir)
await build({ config: builderConfig(env), publish: 'never' })

if (!personal) {
  // Check what actually ships: the build-time flag should have left no Claude code in the app.
  try {
    const archives = packagedArchives(dir)
    if (archives.length === 0) throw new Error(`No packaged app found in ${dir}/ to check`)
    archives.forEach(assertNoClaude)
    console.log(`Checked ${archives.length} app archive(s): no Claude code`)
  } catch (error) {
    // Leave nothing shareable behind.
    clearOutput(dir)
    throw error
  }
}
