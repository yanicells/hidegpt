// Adapted from T3 Code (scripts/build-desktop-artifact.ts, `createBuildConfig`) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { createRequire } from 'node:module'

import type { Configuration } from 'electron-builder'

import { PACKAGED_BINARY_NAME } from '../src/claude/executable.ts'
import { afterPack } from './after-pack.ts'

type Env = Readonly<Record<string, string | undefined>>

const has = (env: Env, ...keys: ReadonlyArray<string>) => keys.every((key) => Boolean(env[key]?.trim()))

/** `HIDEGPT_PERSONAL=1`: the build is for the builder alone and may carry the Claude library. */
export const isPersonal = (env: Env): boolean => env.HIDEGPT_PERSONAL === '1'

/** Where `pnpm dist` writes the build: `dist/`, or `dist/personal/` for a personal one. */
export const outputDir = (env: Env): string => (isPersonal(env) ? 'dist/personal' : 'dist')

/** A certificate is configured: a .p12 in `CSC_LINK`, or a keychain identity in `CSC_NAME`. */
export const wantsSigning = (env: Env): boolean => has(env, 'CSC_LINK') || has(env, 'CSC_NAME')

/** Signed, plus notary credentials in one of the three forms electron-builder accepts. */
export const wantsNotarizing = (env: Env): boolean =>
  wantsSigning(env) &&
  (has(env, 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER') ||
    has(env, 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID') ||
    has(env, 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE'))

/**
 * The SDK's entry bundles its own dependencies, so it and its platform package
 * are all Claude needs. The package's binary is left out of the archive: it
 * ships renamed in Resources instead (see `claudeBinary`).
 */
const CLAUDE_FILES = [
  'node_modules/@anthropic-ai/claude-agent-sdk/**/*',
  'node_modules/@anthropic-ai/claude-agent-sdk-*/**/*',
  '!node_modules/@anthropic-ai/claude-agent-sdk-*/claude',
]

/**
 * The Claude Code binary for this Mac's architecture, which is the one pnpm
 * installed. The platform package is the SDK's own dependency and isn't
 * hoisted, so it's resolved from the SDK's folder, as the SDK resolves it.
 */
export function claudeBinary(arch: string = process.arch): string {
  const require = createRequire(import.meta.url)
  const sdk = require.resolve('@anthropic-ai/claude-agent-sdk')
  return createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-darwin-${arch}/claude`)
}

/**
 * Permission prompts Electron's Info.plist declares. Docs refuses every one of
 * them (src/main/window.ts), so they only advertise a camera and microphone it
 * never asks for. electron-builder deletes keys set to null.
 */
const UNUSED_PERMISSIONS = {
  NSAudioCaptureUsageDescription: null,
  NSBluetoothAlwaysUsageDescription: null,
  NSBluetoothPeripheralUsageDescription: null,
  NSCameraUsageDescription: null,
  NSMicrophoneUsageDescription: null,
}

/** Everything electron-builder reads to sign or notarize. */
export const SIGNING_VARS = [
  'CSC_LINK',
  'CSC_NAME',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE',
]

/**
 * The environment electron-builder gets. It treats any set signing variable as
 * enabled (T3 Code scrubs them the same way), so blank values are dropped, and an
 * unsigned build drops every signing variable and never searches the keychain.
 */
export function builderEnv(env: Env): Record<string, string> {
  const scrubbed: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value?.trim()) scrubbed[key] = value
  }
  if (!wantsSigning(scrubbed)) {
    for (const key of SIGNING_VARS) delete scrubbed[key]
    scrubbed.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  }
  return scrubbed
}

/**
 * The electron-builder config for a macOS `.dmg` and `.zip`. It's built in code, as
 * T3 Code builds its own, because two parts depend on the environment:
 *
 * - Main bundles everything it runs except the Claude SDK, so a shared build,
 *   which has no Claude code (see electron.vite.config.ts), carries no
 *   `node_modules` at all. A personal build carries only the SDK, and ships
 *   its platform binary as `Contents/Resources/Docs Helper`, outside the
 *   archive so it can be spawned and under a name that says nothing.
 * - Signing and notarizing happen only when their env vars are set. Otherwise
 *   the app is ad-hoc signed, which an Apple silicon Mac needs to open it at
 *   all, and the hardened runtime stays off, since it refuses an ad-hoc signed
 *   app's frameworks.
 *
 * Every name a person can see (app, bundle id, menu bar, installer) is "Docs".
 */
export function builderConfig(env: Env, claude: () => string = claudeBinary): Configuration {
  const personal = isPersonal(env)
  const signed = wantsSigning(env)
  return {
    appId: 'app.docs.desktop',
    productName: 'Docs',
    copyright: 'Copyright © 2026',
    // A personal build goes to its own folder with its own name, so it isn't handed out by mistake.
    artifactName: personal ? 'Docs-${version}-${arch}-personal.${ext}' : 'Docs-${version}-${arch}.${ext}',
    directories: { output: outputDir(env), buildResources: 'build' },
    // The package.json inside the app: the Docs name, and in a shared build no dependency
    // list (electron-builder merges objects key by key, so only null clears it).
    extraMetadata: { name: 'docs', productName: 'Docs', ...(personal ? {} : { dependencies: null }) },
    files: ['out/**/*', 'package.json', '!node_modules/**/*', ...(personal ? CLAUDE_FILES : [])],
    ...(personal ? { extraResources: [{ from: claude(), to: PACKAGED_BINARY_NAME }] } : {}),
    electronLanguages: ['en'],
    // Nothing native to rebuild, and nothing is published.
    npmRebuild: false,
    publish: null,
    afterPack,
    mac: {
      target: ['dmg', 'zip'],
      icon: 'icon.icns',
      category: 'public.app-category.productivity',
      // Unset means "use CSC_LINK or CSC_NAME"; "-" is an ad-hoc signature.
      ...(signed ? {} : { identity: '-' }),
      hardenedRuntime: signed,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      notarize: wantsNotarizing(env),
      extendInfo: UNUSED_PERMISSIONS,
    },
    dmg: { title: 'Docs ${version}' },
  }
}
