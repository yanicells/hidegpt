// Adapted from T3 Code (scripts/build-desktop-artifact.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { build } from 'electron-builder'

import { builderConfig, isPersonal, wantsNotarizing, wantsSigning } from './builder-config.ts'
import { verifyPreloadBundle } from './verify-preload-bundle.ts'

/**
 * `pnpm dist`: builds the app, checks the bundle, and packages a macOS `.dmg`
 * and `.zip` into `dist/`. With no env vars it makes an unsigned, Claude-free
 * build. `HIDEGPT_PERSONAL=1` keeps Claude; `CSC_LINK`/`CSC_NAME` sign it; the
 * `APPLE_*` notary vars notarize a signed build (see README, "Packaging").
 */

// electron-builder treats an empty signing variable as set (as T3 Code notes), so drop empty ones.
for (const [key, value] of Object.entries(process.env)) {
  if (value === '') delete process.env[key]
}
const personal = isPersonal(process.env)
if (!wantsSigning(process.env)) {
  // Never pick up a certificate from the keychain unless asked to.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
}

console.log(
  `Building Docs: ${personal ? 'personal (with Claude)' : 'shared (no Claude)'}, ` +
    `${wantsSigning(process.env) ? 'signed' : 'unsigned'}, ${wantsNotarizing(process.env) ? 'notarized' : 'not notarized'}`,
)

rmSync('out', { recursive: true, force: true })
execFileSync('pnpm', ['exec', 'electron-vite', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, HIDEGPT_PERSONAL: personal ? '1' : '0' },
})

verifyPreloadBundle(readFileSync('out/preload/index.cjs', 'utf8'))

if (!personal) {
  // The build-time flag should have dropped every Claude chunk; fail loudly if one survived.
  const leaks = readdirSync('out/main').filter((file) => {
    const source = readFileSync(join('out/main', file), 'utf8')
    return /claude/i.test(file) || source.includes('claude-agent-sdk')
  })
  if (leaks.length > 0) throw new Error(`A shared build still contains Claude code: ${leaks.join(', ')}`)
}

await build({ config: builderConfig(process.env), publish: 'never' })
