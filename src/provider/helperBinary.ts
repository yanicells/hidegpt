// `findOnPath` and `isExecutableFile` are adapted from T3 Code
// (packages/shared/src/shell.ts `resolveCommandPathForPlatform`, `canExecuteFile`) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'

/**
 * Activity Monitor names a process after its executable's file name, so a
 * provider CLI shows up as `codex`, `opencode` or `claude`. `argv0` and
 * symlinks don't change that name; an APFS clone of the binary does, and it
 * keeps the original's code signature and costs no disk space. Every provider
 * process therefore starts from a clone named `Docs Helper`, the name
 * Electron's own helper processes already have.
 *
 * Layout: `<directory>/<hash of the source's real path>/bin/Docs Helper`, with
 * symlinks to the source's siblings beside the clone and to its parent
 * folder's entries one level up, so files a CLI finds relative to its own
 * executable (Codex's `codex-path/rg`, `codex-resources/`) still resolve.
 *
 * Everything here is synchronous, because the Claude SDK's spawn callback is.
 * A start that finds its clone costs about 1 ms; making a clone (once per
 * provider version) takes 10-40 ms and is capped at `CLONE_TIMEOUT_MS`.
 */
export const HELPER_NAME = 'Docs Helper'

/** What to spawn: the command, and the child's env (the caller's, plus what a known launcher sets). */
export type Helper = {
  readonly command: string
  readonly env: Record<string, string | undefined> | undefined
}

/** The parts of `process` this reads; tests pass their own, and can stand in for the clone. */
type Host = {
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  readonly clone?: (source: string, target: string) => void
}

/** Written last, so a clone without it (a start that crashed midway) is rebuilt. */
export const STAMP = '.helper-source.json'
/** The clone's folder: fixed, so no package name (`claude-agent-sdk-darwin-arm64`) shows in `ps`. */
const FOLDER = 'bin'
/** A clone takes 10-40 ms; one that hangs is given up on. */
const CLONE_TIMEOUT_MS = 5_000
/** A package's own folder is small; a shared one (`/usr/local/bin`, a home folder) is not mirrored. */
export const MIRROR_LIMIT = 64
/** Version-manager shims that run whichever tool their name says; renamed, they would not know which. */
const SHIMS = new Set(['mise', 'rtx', 'volta-shim', 'proto-shim'])

/**
 * The command and env to spawn `command` as `Docs Helper`. macOS only, and off
 * when `directory` is null (demo mode, tests) or `DOCS_HELPER_RENAME=0`. Any
 * failure (not on PATH, an unknown script, a disk that can't clone) returns the
 * input unchanged: renaming never stops a provider from starting.
 */
export function resolveHelper(
  command: string,
  env: Record<string, string | undefined> | undefined,
  directory: string | null,
  host: Host = process,
): Helper {
  const unchanged = { command, env }
  if (directory === null || host.platform !== 'darwin' || host.env.DOCS_HELPER_RENAME === '0') return unchanged
  try {
    const found = findOnPath(command, env?.PATH ?? host.env.PATH ?? '')
    if (found === null) return unchanged
    let binary = realpathSync(found)
    // Already renamed: the personal build ships Claude Code under this name.
    if (basename(binary) === HELPER_NAME) return unchanged
    let childEnv = env
    if (isScript(binary)) {
      // A pnpm global bin is a shell shim that names its target.
      const target = shimTarget(binary)
      if (target !== null) binary = realpathSync(target)
    }
    if (isScript(binary)) {
      const launcher = codexLauncher(binary)
      if (launcher === null) return unchanged
      binary = launcher.binary
      childEnv = { ...env, ...launcher.env }
    }
    // A link to a binary of an unrelated name is a multi-call shim (mise runs whichever CLI its
    // name says, as T3 Code notes). A longer name of the same tool (an older Homebrew cask's
    // `codex` -> `codex-aarch64-apple-darwin`) is the tool itself.
    const name = basename(binary)
    if (SHIMS.has(name) || !name.startsWith(basename(found))) return unchanged
    if (!MACH_O.has(readHead(binary).toString('hex'))) return unchanged
    return { command: ensureClone(binary, directory, host.clone ?? cloneFile), env: childEnv }
  } catch {
    return unchanged
  }
}

/**
 * Removes the clone `command` was started from, after it failed to start, so the
 * next start makes a fresh one. Only ever a folder directly inside `directory`.
 */
export function discardHelper(command: string, directory: string | null): void {
  if (directory === null || basename(command) !== HELPER_NAME) return
  const dir = dirname(dirname(command))
  if (dirname(dir) !== directory) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // The next start reuses or rebuilds it.
  }
}

/** POSIX's half of T3 Code's lookup: an explicit path is taken as is, a bare name is searched on PATH. */
function findOnPath(command: string, pathValue: string): string | null {
  if (command.includes('/')) return isAbsolute(command) && isExecutableFile(command) ? command : null
  const seen = new Set<string>()
  for (const raw of pathValue.split(':')) {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1')
    if (entry.length === 0 || seen.has(entry)) continue
    seen.add(entry)
    const candidate = join(entry, command)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function readHead(path: string): Buffer {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(4)
    return head.subarray(0, readSync(fd, head, 0, 4, 0))
  } finally {
    closeSync(fd)
  }
}

const isScript = (path: string) => readHead(path).toString('latin1').startsWith('#!')

/** 64- and 32-bit Mach-O in either byte order, and universal (fat) binaries. */
const MACH_O = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe'])

/** The target pnpm's shell shim names in its last line (`# cmd-shim-target=<path>`), or null. */
function shimTarget(script: string): string | null {
  if (statSync(script).size > 16 * 1024) return null
  const target = /^# cmd-shim-target=(\/.+)$/m.exec(readFileSync(script, 'utf8'))?.[1]
  return target !== undefined && isExecutableFile(target) ? target : null
}

const CODEX_LAUNCHER = `${sep}@openai${sep}codex${sep}bin${sep}codex.js`
const CODEX_TRIPLES: Record<string, string> = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }
const CODEX_MANAGERS = ['NPM', 'BUN', 'PNPM', 'VITE_PLUS'] as const

/**
 * The npm package's `bin/codex.js` finds its platform package's native binary
 * and replaces itself with it, setting the package root and which manager
 * installed it (clearing the others). Spawning that binary directly with the
 * same variables is what the launcher would have run.
 */
function codexLauncher(script: string): { binary: string; env: Record<string, string | undefined> } | null {
  if (!script.endsWith(CODEX_LAUNCHER)) return null
  const triple = CODEX_TRIPLES[process.arch]
  if (!triple) return null
  const packageRoot = realpathSync(join(dirname(script), '..'))
  let vendor: string
  try {
    // The launcher's own lookup: the platform package, resolved from the script.
    const manifest = createRequire(script).resolve(`@openai/codex-darwin-${process.arch}/package.json`)
    vendor = join(dirname(manifest), 'vendor')
  } catch {
    vendor = join(packageRoot, 'vendor')
  }
  const binary = join(vendor, triple, 'bin', 'codex')
  if (!isExecutableFile(binary)) return null
  // The launcher's guess, simplified: started from an app (no `npm_config_user_agent`), it says
  // npm unless the install sits in bun's or pnpm's global folder (Vite+'s is not checked here).
  const manager = script.includes(`${sep}.bun${sep}install${sep}global${sep}`)
    ? 'BUN'
    : script.includes(`${sep}pnpm${sep}global${sep}`)
      ? 'PNPM'
      : 'NPM'
  const env: Record<string, string | undefined> = { CODEX_MANAGED_PACKAGE_ROOT: packageRoot }
  for (const each of CODEX_MANAGERS) env[`CODEX_MANAGED_BY_${each}`] = each === manager ? '1' : undefined
  return { binary, env }
}

/** clonefile(2) through `cp -c`, which fails rather than copy. (Node's FICLONE_FORCE is ENOSYS on macOS; FICLONE copies.) */
function cloneFile(source: string, target: string): void {
  execFileSync('/bin/cp', ['-c', source, target], { stdio: 'ignore', timeout: CLONE_TIMEOUT_MS, killSignal: 'SIGKILL' })
}

type Stamp = { readonly source: string; readonly size: number; readonly mtimeMs: number; readonly ino: number }

function stampOf(source: string): Stamp {
  const { size, mtimeMs, ino } = statSync(source)
  return { source, size, mtimeMs, ino }
}

function readStamp(dir: string): Stamp | null {
  try {
    return JSON.parse(readFileSync(join(dir, STAMP), 'utf8')) as Stamp
  } catch {
    return null
  }
}

const sameStamp = (a: Stamp | null, b: Stamp) =>
  a !== null && a.source === b.source && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino

/**
 * The clone of `source`, made (or remade, when the source's size, modified
 * time or inode changed: an update) if needed. Main holds the single-instance
 * lock and this runs synchronously, so two builds of one folder never overlap.
 */
function ensureClone(source: string, directory: string, clone: (source: string, target: string) => void): string {
  const stamp = stampOf(source)
  const dir = join(directory, createHash('sha256').update(source).digest('hex').slice(0, 16))
  const helper = join(dir, FOLDER, HELPER_NAME)
  if (sameStamp(readStamp(dir), stamp) && isExecutableFile(helper)) return helper

  // A process running from the old clone keeps its open file, but its sibling links are rebuilt
  // under it, and anything that re-runs its own path gets the new clone.
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, FOLDER), { recursive: true })
  // A disk that can't clone throws here, and the caller falls back to the original.
  clone(source, helper)
  mirror(dirname(source), join(dir, FOLDER), basename(source))
  mirror(dirname(dirname(source)), dir, FOLDER)
  writeFileSync(join(dir, STAMP), JSON.stringify(stamp))
  pruneStale(directory, dir)
  return helper
}

/** Symlinks each entry of `from` (but `skip`) into `to`. */
function mirror(from: string, to: string, skip: string): void {
  const entries = readdirSync(from).filter((name) => name !== skip && name !== STAMP)
  if (entries.length > MIRROR_LIMIT) return
  for (const name of entries) symlinkSync(join(from, name), join(to, name))
}

/**
 * Clones whose source is gone (an old version) would keep its disk blocks alive,
 * and one without a stamp never finished, so both go.
 */
function pruneStale(directory: string, keep: string): void {
  for (const name of readdirSync(directory)) {
    const dir = join(directory, name)
    if (dir === keep) continue
    const stamp = readStamp(dir)
    let gone = stamp === null
    if (stamp !== null) {
      try {
        statSync(stamp.source)
      } catch {
        gone = true
      }
    }
    if (gone) rmSync(dir, { recursive: true, force: true })
  }
}
