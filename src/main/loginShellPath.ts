// Adapted from T3 Code (packages/shared/src/shell.ts `readEnvironmentFromLoginShell`,
// `listLoginShellCandidates`, `mergePathEntries`; apps/server/src/os-jank.ts;
// apps/desktop/src/shell/DesktopShellEnvironment.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { userInfo } from 'node:os'
import { basename } from 'node:path'

/**
 * An app opened from Finder starts with launchd's bare PATH, so CLIs installed
 * under nvm, Volta, fnm, npm globals or `~/.opencode/bin` aren't found. This
 * asks the person's login shell for its PATH at launch, as T3 Code does, without
 * blocking: the window paints while the shell starts, and only provider starts
 * wait for it. Nothing here logs: PATH can name private folders.
 */

const START = '__DOCS_PATH_START__'
const END = '__DOCS_PATH_END__'
/**
 * How long all candidate shells get together; each gets what the ones before it left.
 * A slow profile delays the first provider start by at most this much. It's generous
 * because a miss lasts until relaunch (T3 Code allows 5 s per shell).
 */
const LOOKUP_BUDGET_MS = 4_000

/** The probe still running, so a quit can kill it (and its process group). */
let live: ChildProcess | undefined

function killGroup(child: ChildProcess): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // The group is already gone.
  }
}

/** Kills a lookup still running; main calls this on `will-quit`. */
export function killLoginShellProbe(): void {
  if (live) killGroup(live)
}

type Spawn = (file: string, args: ReadonlyArray<string>, options: SpawnOptions) => ChildProcess

/**
 * Prints PATH between markers, so a profile's own output (banners, motd) can't be
 * mistaken for it. Nushell rejects this syntax (`||`, `printf`), so the probe fails
 * there and the next shell candidate (usually /bin/zsh) answers instead.
 */
export function pathCaptureCommand(shell: string): string {
  const capture = `printf '%s\\n' '${START}'; printenv PATH || true; printf '%s\\n' '${END}'`
  // A DEBUG trap that echoes each command would print the markers too (as in T3 Code).
  return ['bash', 'zsh', 'sh', 'ksh'].includes(basename(shell).toLowerCase())
    ? `(trap - DEBUG) 2>/dev/null && trap - DEBUG; ${capture}`
    : capture
}

/** The PATH between the markers, or undefined if the shell printed none (yet). */
export function extractPath(output: string): string | undefined {
  const start = output.indexOf(START)
  if (start === -1) return undefined
  const end = output.indexOf(END, start + START.length)
  if (end === -1) return undefined
  const value = output.slice(start + START.length, end).trim()
  return value || undefined
}

const ended = (output: string) => {
  const start = output.indexOf(START)
  return start !== -1 && output.includes(END, start + START.length)
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

/**
 * The login shell's PATH, or undefined if the shell fails, prints none, or takes too
 * long. It answers as soon as the end marker arrives, then kills the shell's whole
 * process group, so a profile that leaves a background job holding stdout neither
 * delays it nor leaks the job.
 */
export function readLoginShellPath(
  shell: string,
  timeoutMs: number,
  spawnShell: Spawn = spawn,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      // Interactive, so profiles that set PATH only for interactive shells run; detached,
      // so it leads its own process group and job control on a terminal can't stop it.
      child = spawnShell(shell, ['-ilc', pathCaptureCommand(shell)], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve(undefined)
      return
    }
    live = child
    let output = ''
    let done = false
    const finish = (path: string | undefined) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (live === child) live = undefined
      child.stdout?.destroy()
      killGroup(child)
      resolve(path)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
      if (ended(output)) finish(extractPath(output))
    })
    child.on('error', () => finish(undefined))
    child.on('close', () => finish(extractPath(output)))
  })
}

/**
 * `$SHELL`, then the account's shell, then /bin/zsh, without repeats (T3 Code's
 * `listLoginShellCandidates`). The caller passes the account shell (from
 * `readAccountShell`), so the result depends only on the arguments.
 */
export function loginShellCandidates(env: NodeJS.ProcessEnv, accountShell: string | undefined): ReadonlyArray<string> {
  const candidates = [env.SHELL?.trim(), accountShell?.trim(), '/bin/zsh'].filter((shell): shell is string =>
    Boolean(shell),
  )
  return [...new Set(candidates)]
}

function readAccountShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined
  } catch {
    return undefined
  }
}

/** The first PATH a candidate shell gives, trying them in order within one time budget. */
export async function firstLoginShellPath(
  shells: ReadonlyArray<string>,
  read: (shell: string, timeoutMs: number) => Promise<string | undefined> = readLoginShellPath,
  budgetMs = LOOKUP_BUDGET_MS,
  now: () => number = Date.now,
): Promise<string | undefined> {
  const deadline = now() + budgetMs
  for (const shell of shells) {
    const left = deadline - now()
    if (left <= 0) break
    const path = await read(shell, left)
    if (path) return path
  }
  return undefined
}

/**
 * Sets main's PATH on macOS. Right away: the usual Homebrew, bun and local folders
 * ahead of what the app got. For a packaged app it also starts the login-shell
 * lookup, and the returned promise settles once that PATH is merged in front; a dev
 * run already has the terminal's PATH and never spawns a shell. Never rejects.
 */
export function hydratePath(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
  findShellPath: () => Promise<string | undefined> = () =>
    firstLoginShellPath(loginShellCandidates(env, readAccountShell())),
): Promise<void> {
  const home = env.HOME ?? ''
  const fallback = ['/opt/homebrew/bin', '/usr/local/bin', home && `${home}/.bun/bin`, home && `${home}/.local/bin`]
  env.PATH = mergePaths(fallback.filter(Boolean).join(':'), env.PATH)
  if (!packaged) return Promise.resolve()
  return findShellPath().then(
    (shellPath) => {
      if (shellPath) env.PATH = mergePaths(shellPath, env.PATH)
    },
    () => undefined,
  )
}
