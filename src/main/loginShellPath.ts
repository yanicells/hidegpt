// Adapted from T3 Code (packages/shared/src/shell.ts `readEnvironmentFromLoginShell`,
// `mergePathEntries`; apps/server/src/os-jank.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { basename } from 'node:path'

/**
 * An app opened from Finder starts with launchd's bare PATH, so CLIs installed
 * under nvm, Volta, fnm, npm globals or `~/.opencode/bin` aren't found. This
 * asks the person's login shell for its PATH once at launch, the way T3 Code
 * does, and puts it first. Nothing here logs: PATH can name private folders.
 */

const START = '__DOCS_PATH_START__'
const END = '__DOCS_PATH_END__'
/** A slow profile costs at most this much launch time; then the fallback folders apply. */
const SHELL_TIMEOUT_MS = 2_000

type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: 'utf8'; timeout: number; killSignal: 'SIGKILL'; detached: boolean; stdio: ['ignore', 'pipe', 'ignore'] },
) => string

/** Prints PATH between markers, so a profile's own output (banners, motd) can't be mistaken for it. */
export function pathCaptureCommand(shell: string): string {
  const capture = `printf '%s\\n' '${START}'; printenv PATH || true; printf '%s\\n' '${END}'`
  // A DEBUG trap that echoes each command would print the markers too (as in T3 Code).
  return ['bash', 'zsh', 'sh', 'ksh'].includes(basename(shell).toLowerCase())
    ? `(trap - DEBUG) 2>/dev/null && trap - DEBUG; ${capture}`
    : capture
}

/** The PATH between the markers, or undefined if the shell printed none. */
export function extractPath(output: string): string | undefined {
  const start = output.indexOf(START)
  if (start === -1) return undefined
  const end = output.indexOf(END, start + START.length)
  if (end === -1) return undefined
  const value = output.slice(start + START.length, end).trim()
  return value || undefined
}

/** Joins PATH values in order of preference, dropping blanks and repeats. */
export function mergePaths(...paths: ReadonlyArray<string | undefined>): string {
  const seen = new Set<string>()
  for (const path of paths) {
    for (const entry of path?.split(':') ?? []) {
      const trimmed = entry.trim()
      if (trimmed) seen.add(trimmed)
    }
  }
  return [...seen].join(':')
}

/** The login shell's PATH, or undefined if the shell fails, prints nothing, or takes too long. */
export function readLoginShellPath(shell: string, execFile: ExecFileSyncLike = execFileSync as ExecFileSyncLike): string | undefined {
  try {
    // Interactive, so profiles that set PATH only for interactive shells run; detached,
    // so job control on an inherited terminal can't stop the probe.
    return extractPath(
      execFile(shell, ['-ilc', pathCaptureCommand(shell)], {
        encoding: 'utf8',
        timeout: SHELL_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    )
  } catch {
    return undefined
  }
}

function loginShell(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.SHELL?.trim()
  if (fromEnv) return fromEnv
  try {
    return userInfo().shell?.trim() || '/bin/zsh'
  } catch {
    return '/bin/zsh'
  }
}

/**
 * The PATH main should run with on macOS: the login shell's PATH (asked only for a
 * packaged app, since a dev run already inherits the terminal's), then the
 * usual Homebrew, bun and local folders as a fallback, then what the app got.
 */
export function launchPath(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
  readShellPath: (shell: string) => string | undefined = readLoginShellPath,
): string {
  const home = env.HOME ?? ''
  const fallback = ['/opt/homebrew/bin', '/usr/local/bin', home && `${home}/.bun/bin`, home && `${home}/.local/bin`]
  return mergePaths(packaged ? readShellPath(loginShell(env)) : undefined, fallback.filter(Boolean).join(':'), env.PATH)
}
