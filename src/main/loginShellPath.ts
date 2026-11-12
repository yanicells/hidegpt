// Adapted from T3 Code (packages/shared/src/shell.ts `readEnvironmentFromLoginShell`,
// `listLoginShellCandidates`, `mergePathEntries`; apps/server/src/os-jank.ts;
// apps/desktop/src/shell/DesktopShellEnvironment.ts, including its cache file and
// background refresh) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'

import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

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
/** Set at quit, so a lookup still trying shells starts no other. */
let quitting = false

function killGroup(child: ChildProcess): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // The group is already gone.
  }
}

/** Kills a lookup still running, and keeps it from trying the next shell; main calls this on `will-quit`. */
export function killLoginShellProbe(): void {
  quitting = true
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
    if (quitting) {
      resolve(undefined)
      return
    }
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

/** The cache file in `userData`: the login shell's PATH and the `$SHELL` it was read under. */
const CACHE_FILE = 'login-shell-path.json'
const CachedPath = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), shell: Schema.String, path: Schema.String }),
)
const decodeCache = Schema.decodeUnknownOption(CachedPath)
const encodeCache = Schema.encodeSync(CachedPath)

/** The file calls the cache makes; tests pass an in-memory stand-in. */
export interface CacheFiles {
  readonly read: (file: string) => Promise<string>
  /** Writes `text` to `file` whole or not at all. */
  readonly write: (file: string, text: string) => Promise<void>
}

/** A temp file then a rename (as T3 Code), so a crash mid-write never leaves half a file. */
const nodeFiles: CacheFiles = {
  read: (file) => readFile(file, 'utf8'),
  write: async (file, text) => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, text, { mode: 0o600 })
    await rename(`${file}.tmp`, file)
  },
}

/** The lookup running behind a cache hit; settled when there is none. */
let refreshing: Promise<void> = Promise.resolve()

/**
 * Settles once the login-shell lookup that runs behind a cache hit has finished and
 * any new PATH is in place (at once if none is running). Never rejects. A provider
 * whose CLI is missing on the cached PATH waits for this once before giving up.
 */
export const pathRefreshed = (): Promise<void> => refreshing

export interface HydrateOptions {
  /** Asks the login shell for its PATH. */
  readonly findShellPath?: () => Promise<string | undefined>
  readonly files?: CacheFiles
}

/**
 * Sets main's PATH on macOS. Right away: the usual Homebrew, bun and local folders
 * ahead of what the app got. For a packaged app it then puts the login shell's PATH
 * in front, and the returned promise settles once it has. A dev run already has the
 * terminal's PATH and never spawns a shell. Never rejects.
 *
 * The shell takes over a second, so its answer is cached in `cacheDirectory` with the
 * `$SHELL` it came from. With a cached answer for the same `$SHELL` the promise settles
 * at once and the shell runs behind it (`pathRefreshed`), updating PATH and the file
 * if its answer changed. Without one (or if the file is unreadable) it waits for the
 * shell, then saves the answer.
 */
export function hydratePath(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
  cacheDirectory: string,
  {
    findShellPath = () => firstLoginShellPath(loginShellCandidates(env, readAccountShell())),
    files = nodeFiles,
  }: HydrateOptions = {},
): Promise<void> {
  const home = env.HOME ?? ''
  const fallback = ['/opt/homebrew/bin', '/usr/local/bin', home && `${home}/.bun/bin`, home && `${home}/.local/bin`]
  env.PATH = mergePaths(fallback.filter(Boolean).join(':'), env.PATH)
  refreshing = Promise.resolve()
  if (!packaged) return Promise.resolve()

  // Every answer goes in front of this, so an entry the shell drops doesn't linger.
  const base = env.PATH
  const shell = env.SHELL?.trim() ?? ''
  const file = join(cacheDirectory, CACHE_FILE)
  const lookup = () => findShellPath().catch(() => undefined)
  const save = (path: string) => files.write(file, encodeCache({ version: 1, shell, path })).catch(() => undefined)

  return files
    .read(file)
    .then(
      (text) => {
        const cached = Option.getOrUndefined(decodeCache(text))
        return cached?.shell === shell && cached.path ? cached.path : undefined
      },
      () => undefined,
    )
    .then(async (cached) => {
      if (cached === undefined) {
        const fresh = await lookup()
        if (!fresh) return
        env.PATH = mergePaths(fresh, base)
        await save(fresh)
        return
      }
      env.PATH = mergePaths(cached, base)
      refreshing = lookup().then(async (fresh) => {
        if (!fresh || fresh === cached) return
        env.PATH = mergePaths(fresh, base)
        await save(fresh)
      })
    })
}
