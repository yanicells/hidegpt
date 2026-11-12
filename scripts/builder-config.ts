// Adapted from T3 Code (scripts/build-desktop-artifact.ts, `createBuildConfig`) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { Configuration } from 'electron-builder'

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
 * The SDK's entry (`sdk.mjs`) bundles its own dependencies and imports no file beside
 * it, so it and its platform binary are all Claude needs. Its other entry points
 * (bridge, browser, core) and type declarations are left out.
 */
const CLAUDE_FILES = [
  'node_modules/@anthropic-ai/claude-agent-sdk/**/*',
  '!node_modules/@anthropic-ai/claude-agent-sdk/{bridge.mjs,browser-sdk.js,core*.mjs,*.d.ts}',
  'node_modules/@anthropic-ai/claude-agent-sdk-*/**/*',
]
const CLAUDE_BINARY = 'node_modules/@anthropic-ai/claude-agent-sdk-*/**/*'

/**
 * Electron's default reasons for camera, microphone and Bluetooth access read as
 * generic. Docs never asks for them, so they say so in plain words (a plist can't
 * hold a null, so they can't simply be removed).
 */
const UNUSED_ACCESS = {
  NSCameraUsageDescription: 'Docs does not use the camera.',
  NSMicrophoneUsageDescription: 'Docs does not use the microphone.',
  NSAudioCaptureUsageDescription: 'Docs does not record audio.',
  NSBluetoothAlwaysUsageDescription: 'Docs does not use Bluetooth.',
  NSBluetoothPeripheralUsageDescription: 'Docs does not use Bluetooth.',
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
 * The electron-builder config for a macOS `.dmg`. It's built in code, as
 * T3 Code builds its own, because two parts depend on the environment:
 *
 * - Main bundles everything it runs except the Claude SDK, so a shared build,
 *   which has no Claude code (see electron.vite.config.ts), carries no
 *   `node_modules` at all. A personal build carries only the SDK, and unpacks
 *   its platform binary so it can be spawned.
 * - Signing and notarizing happen only when their env vars are set. Otherwise
 *   the app is ad-hoc signed, which an Apple silicon Mac needs to open it at
 *   all, and the hardened runtime stays off, since it refuses an ad-hoc signed
 *   app's frameworks.
 *
 * Every name a person can see (app, bundle id, menu bar, installer) is "Docs".
 */
export function builderConfig(env: Env): Configuration {
  const personal = isPersonal(env)
  const signed = wantsSigning(env)
  return {
    appId: 'app.docs.desktop',
    productName: 'Docs',
    copyright: 'Copyright © 2026',
    // A personal build goes to its own folder with its own name, so it isn't handed out by mistake.
    artifactName: personal ? 'Docs-${version}-${arch}-personal.${ext}' : 'Docs-${version}-${arch}.${ext}',
    directories: { output: outputDir(env), buildResources: 'build' },
    // The package.json inside the app: the Docs name, no dev tooling fields, and in a shared
    // build no dependency list (electron-builder merges objects key by key, so only null clears them).
    extraMetadata: {
      name: 'docs',
      productName: 'Docs',
      engines: null,
      packageManager: null,
      ...(personal ? {} : { dependencies: null }),
    },
    files: ['out/**/*', 'package.json', '!node_modules/**/*', ...(personal ? CLAUDE_FILES : [])],
    asarUnpack: personal ? [CLAUDE_BINARY] : [],
    electronLanguages: ['en'],
    // Nothing native to rebuild, and nothing is published.
    npmRebuild: false,
    publish: null,
    mac: {
      // Just the .dmg: nothing auto-updates, so no .zip or blockmaps.
      target: ['dmg'],
      icon: 'icon.icns',
      category: 'public.app-category.productivity',
      // Unset means "use CSC_LINK or CSC_NAME"; "-" is an ad-hoc signature.
      ...(signed ? {} : { identity: '-' }),
      hardenedRuntime: signed,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      notarize: wantsNotarizing(env),
      extendInfo: {
        // Stops macOS offering one-time codes from Messages over the composer (as T3 Code does).
        NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,
        ...UNUSED_ACCESS,
      },
    },
    dmg: { title: 'Docs ${version}', writeUpdateInfo: false },
  }
}
