import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Shared by the helper tests. Node itself (`process.execPath`), a signed
 * third-party Mach-O like the provider CLIs, stands in for a provider binary.
 */

/** macOS checks a new executable on its first launch: seconds for a 100 MB binary on a busy machine. */
export const FIRST_LAUNCH_MS = 30_000

/** A clone of Node at `path` (instant on APFS; Node's own COPYFILE_FICLONE makes a full copy). */
export const nodeAt = (path: string) => {
  mkdirSync(dirname(path), { recursive: true })
  execFileSync('/bin/cp', ['-c', process.execPath, path])
  return path
}

/** The kernel's name for `pid`: what Activity Monitor shows (`ps` cuts it at 16 characters). */
export const processName = (pid: number) =>
  execFileSync('/bin/ps', ['-o', 'ucomm=', '-p', String(pid)], { encoding: 'utf8' }).trim()

/** Writes an executable file with `text`. */
export const executable = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
  return path
}

const CODEX_TRIPLE = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'

/**
 * The Codex npm package's layout under `prefix`: `@openai/codex/bin/codex.js` (with `launcher` as
 * its text) and the platform package's native binary (Node) under `vendor/<triple>/bin/codex`.
 */
export const codexInstall = (prefix: string, launcher = '#!/usr/bin/env node\n') => {
  const pkg = join(prefix, 'node_modules', '@openai', 'codex')
  const platformPkg = join(pkg, 'node_modules', '@openai', `codex-darwin-${process.arch}`)
  const launcherPath = executable(join(pkg, 'bin', 'codex.js'), launcher)
  nodeAt(join(platformPkg, 'vendor', CODEX_TRIPLE, 'bin', 'codex'))
  writeFileSync(join(platformPkg, 'package.json'), '{"name":"platform"}')
  const codexPath = join(platformPkg, 'vendor', CODEX_TRIPLE, 'codex-path')
  mkdirSync(codexPath)
  return { pkg, launcher: launcherPath, codexPath }
}
