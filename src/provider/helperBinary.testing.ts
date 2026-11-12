import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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
