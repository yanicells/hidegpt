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
 * Layout: `<directory>/<hash of the source's real path>/<source's folder>/Docs Helper`,
 * with symlinks to the source's siblings beside the clone and to its parent
 * folder's entries one level up, so files a CLI finds relative to its own
 * executable (Codex's `codex-path/rg`, `codex-resources/`) still resolve.
 */
export const HELPER_NAME = 'Docs Helper'

/** What to spawn: the command, and the child's env (the caller's, plus what a known launcher sets). */
export type Helper = {
  readonly command: string
  readonly env: Record<string, string | undefined> | undefined
}

/** The parts of `process` this reads; tests pass their own. */
type Host = { readonly platform: NodeJS.Platform; readonly env: NodeJS.ProcessEnv }

/** Written last, so a clone without it (a start that crashed midway) is rebuilt. */
const STAMP = '.helper-source.json'
/** A clone takes about 10 ms; one that hangs is given up on. */
const CLONE_TIMEOUT_MS = 5_000
/** A package's own folder is small; a shared one (`/usr/local/bin`, a home folder) is not mirrored. */
const MIRROR_LIMIT = 64

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
    if (readHead(binary).toString('latin1').startsWith('#!')) {
      const launcher = codexLauncher(binary)
      if (launcher === null) return unchanged
      binary = launcher.binary
      childEnv = { ...env, ...launcher.env }
    }
    // A link to a binary of another name is a multi-call tool (a mise shim runs whichever CLI its
    // name says, as T3 Code notes); renamed, it would not know what to run.
    if (basename(binary) !== basename(found)) return unchanged
    if (!MACH_O.has(readHead(binary).toString('hex'))) return unchanged
    return { command: ensureClone(binary, directory), env: childEnv }
  } catch {
    return unchanged
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

/** 64- and 32-bit Mach-O in either byte order, and universal (fat) binaries. */
const MACH_O = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe'])

const CODEX_LAUNCHER = `${sep}@openai${sep}codex${sep}bin${sep}codex.js`
const CODEX_TRIPLES: Record<string, string> = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }

/**
 * The npm package's `bin/codex.js` finds its platform package's native binary
 * and replaces itself with it, adding two variables. Spawning that binary
 * directly with the same variables is what the launcher would have run.
 */
function codexLauncher(script: string): { binary: string; env: Record<string, string> } | null {
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
  // The launcher also names the package manager that installed it. Started from an app (no
  // `npm_config_user_agent`), it says npm unless it finds bun, pnpm or Vite+ metadata; only bun's
  // folder is checked here. Codex reads it to tell how it was installed.
  const manager = script.includes(`${sep}.bun${sep}install${sep}global${sep}`) ? 'BUN' : 'NPM'
  return { binary, env: { CODEX_MANAGED_PACKAGE_ROOT: packageRoot, [`CODEX_MANAGED_BY_${manager}`]: '1' } }
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
function ensureClone(source: string, directory: string): string {
  const stamp = stampOf(source)
  const dir = join(directory, createHash('sha256').update(source).digest('hex').slice(0, 16))
  const folder = basename(dirname(source))
  const clone = join(dir, folder, HELPER_NAME)
  if (sameStamp(readStamp(dir), stamp) && isExecutableFile(clone)) return clone

  // A process still running from the old clone keeps its file: removing it only unlinks the name.
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, folder), { recursive: true })
  // clonefile(2), which fails rather than copy, so a disk that can't clone falls back to the
  // original. (Node's COPYFILE_FICLONE_FORCE is ENOSYS on macOS, and FICLONE makes a full copy.)
  execFileSync('/bin/cp', ['-c', source, clone], { stdio: 'ignore', timeout: CLONE_TIMEOUT_MS, killSignal: 'SIGKILL' })
  mirror(dirname(source), join(dir, folder), basename(source))
  mirror(dirname(dirname(source)), dir, folder)
  writeFileSync(join(dir, STAMP), JSON.stringify(stamp))
  pruneStale(directory, dir)
  return clone
}

/** Symlinks each entry of `from` (but `skip`) into `to`. */
function mirror(from: string, to: string, skip: string): void {
  const entries = readdirSync(from).filter((name) => name !== skip && name !== STAMP)
  if (entries.length > MIRROR_LIMIT) return
  for (const name of entries) symlinkSync(join(from, name), join(to, name))
}

/** Clones whose source is gone (an old version) would keep its disk blocks alive, so they go. */
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
