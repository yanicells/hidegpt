import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { HELPER_NAME, MIRROR_LIMIT, STAMP, resolveHelper } from './helperBinary'
import { FIRST_LAUNCH_MS, nodeAt, processName } from './helperBinary.testing'

/** Real clones of a real binary (Node). Nothing here starts a provider. */
// Real path: macOS's temp folder sits behind a symlink, and clones are keyed by real paths.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'hidegpt-helper-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mac = { platform: 'darwin' as const, env: {} }
let count = 0
/** A fresh helpers folder for each test. */
const helpersDir = () => join(root, `helpers-${(count += 1)}`)
/** The clone's own folder, `<directory>/<hash>`. */
const folderOf = (clone: string) => dirname(dirname(clone))
const executable = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
  return path
}

describe.runIf(process.platform === 'darwin')('resolveHelper', () => {
  it(
    'starts a binary found on PATH as Docs Helper',
    async () => {
      const bin = join(root, 'path-bin')
      mkdirSync(bin)
      symlinkSync(process.execPath, join(bin, 'node'))
      const helper = resolveHelper('node', { PATH: bin }, helpersDir(), mac)
      expect(helper.command.endsWith(`/${HELPER_NAME}`)).toBe(true)

      const child = spawn(helper.command, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' })
      try {
        await new Promise((resolve) => child.once('spawn', resolve))
        expect(processName(child.pid!)).toBe(HELPER_NAME)
      } finally {
        process.kill(child.pid!, 'SIGKILL')
      }
    },
    FIRST_LAUNCH_MS,
  )

  it('keeps the clone in a fixed folder, with the binary’s siblings and its parent’s entries linked around it', () => {
    const pkg = join(root, 'pkg')
    const source = nodeAt(join(pkg, 'claude-agent-sdk-darwin-arm64', 'tool'))
    writeFileSync(join(pkg, 'claude-agent-sdk-darwin-arm64', 'tool-helper'), '')
    mkdirSync(join(pkg, 'tool-resources'))
    const dir = helpersDir()
    const clone = resolveHelper(source, undefined, dir, mac).command
    // No package name in the path `ps` shows.
    expect(clone).toMatch(new RegExp(`^${dir}/[0-9a-f]{16}/bin/${HELPER_NAME}$`))
    expect(readlinkSync(join(clone, '..', 'tool-helper'))).toBe(
      join(pkg, 'claude-agent-sdk-darwin-arm64', 'tool-helper'),
    )
    expect(readlinkSync(join(clone, '..', '..', 'tool-resources'))).toBe(join(pkg, 'tool-resources'))
  })

  it('does not mirror a crowded folder', () => {
    const shared = join(root, 'shared-bin')
    const source = nodeAt(join(shared, 'tool'))
    for (let i = 0; i <= MIRROR_LIMIT; i += 1) writeFileSync(join(shared, `other-${i}`), '')
    const clone = resolveHelper(source, undefined, helpersDir(), mac).command
    expect(readdirSync(dirname(clone))).toEqual([HELPER_NAME])
  })

  it('reuses the clone, and clones again once the source changes', () => {
    const source = nodeAt(join(root, 'updated', 'bin', 'tool'))
    const dir = helpersDir()
    const first = resolveHelper(source, undefined, dir, mac).command
    const inode = statSync(first).ino
    expect(statSync(resolveHelper(source, undefined, dir, mac).command).ino).toBe(inode)

    utimesSync(source, new Date(), new Date(Date.now() + 60_000))
    const second = resolveHelper(source, undefined, dir, mac).command
    expect(second).toBe(first)
    expect(statSync(second).ino).not.toBe(inode)
  })

  it('removes clones whose source is gone and unfinished ones, and keeps the rest', () => {
    const dir = helpersDir()
    const [unfinished, removed, kept, next] = ['a', 'b', 'c', 'd'].map((name) =>
      nodeAt(join(root, 'prune', name, 'tool')),
    )
    const clones = [unfinished, removed, kept].map((source) => resolveHelper(source!, undefined, dir, mac).command)
    const [unfinishedClone, removedClone, keptClone] = clones as [string, string, string]
    const unfinishedInode = statSync(unfinishedClone).ino
    const keptInode = statSync(keptClone).ino
    rmSync(join(folderOf(unfinishedClone), STAMP))
    rmSync(removed!)

    resolveHelper(next!, undefined, dir, mac)
    expect(existsSync(folderOf(removedClone))).toBe(false)
    expect(statSync(keptClone).ino).toBe(keptInode)
    // An unfinished clone is never trusted: the next start of its source builds it again.
    expect(resolveHelper(unfinished!, undefined, dir, mac).command).toBe(unfinishedClone)
    expect(statSync(unfinishedClone).ino).not.toBe(unfinishedInode)
  })

  it('starts the original when the clone cannot be made, and leaves nothing a later clone keeps', () => {
    const source = nodeAt(join(root, 'failing', 'bin', 'tool'))
    const dir = helpersDir()
    const failing = {
      ...mac,
      clone: () => {
        throw new Error('EXDEV: cross-device clone')
      },
    }
    expect(resolveHelper(source, { A: '1' }, dir, failing)).toEqual({ command: source, env: { A: '1' } })
    const other = resolveHelper(nodeAt(join(root, 'failing', 'other', 'tool')), undefined, dir, mac).command
    expect(readdirSync(dir)).toEqual([basename(folderOf(other))])

    // An unwritable helpers folder falls back the same way.
    const readonly = helpersDir()
    mkdirSync(readonly)
    chmodSync(readonly, 0o500)
    try {
      expect(resolveHelper(source, undefined, readonly, mac).command).toBe(source)
    } finally {
      chmodSync(readonly, 0o700)
    }
  })

  it('leaves the command alone when off, off macOS, in demo mode, already renamed, a shim, or not a binary', () => {
    const bin = join(root, 'plain', 'bin')
    const source = nodeAt(join(bin, 'tool'))
    const renamed = nodeAt(join(root, 'plain', 'Resources', HELPER_NAME))
    const script = executable(join(bin, 'script'), '#!/bin/sh\n')
    const data = executable(join(bin, 'data'), 'not a program')
    const dir = helpersDir()
    const unchanged = { command: source, env: undefined }
    expect(resolveHelper(source, undefined, dir, { platform: 'darwin', env: { DOCS_HELPER_RENAME: '0' } })).toEqual(
      unchanged,
    )
    expect(resolveHelper(source, undefined, dir, { platform: 'linux', env: {} })).toEqual(unchanged)
    expect(resolveHelper(source, undefined, null, mac)).toEqual(unchanged)
    expect(resolveHelper(renamed, undefined, dir, mac).command).toBe(renamed)
    expect(resolveHelper(script, undefined, dir, mac).command).toBe(script)
    expect(resolveHelper(data, undefined, dir, mac).command).toBe(data)
    // A link to a binary of an unrelated name, or to a version manager's shim, runs whatever its
    // name says (mise, Volta): renamed, it would not know what to run.
    symlinkSync(source, join(bin, 'shim'))
    expect(resolveHelper('shim', { PATH: bin }, dir, mac).command).toBe('shim')
    nodeAt(join(root, 'plain', 'volta', 'volta-shim'))
    symlinkSync(join(root, 'plain', 'volta', 'volta-shim'), join(bin, 'volta'))
    expect(resolveHelper('volta', { PATH: bin }, dir, mac).command).toBe('volta')
    expect(resolveHelper('hidegpt-no-such-binary', { PATH: bin }, dir, mac).command).toBe('hidegpt-no-such-binary')
    expect(existsSync(dir)).toBe(false)
  })

  it('renames a link to a longer name of the same tool (a Homebrew cask’s codex-aarch64-apple-darwin)', () => {
    const bin = join(root, 'cask', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(nodeAt(join(root, 'cask', 'Caskroom', 'tool-aarch64-apple-darwin')), join(bin, 'tool'))
    expect(resolveHelper('tool', { PATH: bin }, helpersDir(), mac).command.endsWith(`/${HELPER_NAME}`)).toBe(true)
  })

  describe('the Codex npm package', () => {
    const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    /** The npm layout: `bin/codex.js` and the platform package's native binary under `vendor/`. */
    const install = (prefix: string) => {
      const pkg = join(prefix, 'node_modules', '@openai', 'codex')
      const platformPkg = join(pkg, 'node_modules', '@openai', `codex-darwin-${process.arch}`)
      executable(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n')
      nodeAt(join(platformPkg, 'vendor', triple, 'bin', 'codex'))
      writeFileSync(join(platformPkg, 'package.json'), '{"name":"platform"}')
      mkdirSync(join(platformPkg, 'vendor', triple, 'codex-path'))
      return { pkg, codexPath: join(platformPkg, 'vendor', triple, 'codex-path') }
    }
    const managers = (by: string) => ({
      CODEX_MANAGED_BY_NPM: by === 'NPM' ? '1' : undefined,
      CODEX_MANAGED_BY_BUN: by === 'BUN' ? '1' : undefined,
      CODEX_MANAGED_BY_PNPM: by === 'PNPM' ? '1' : undefined,
      CODEX_MANAGED_BY_VITE_PLUS: undefined,
    })

    it('starts the native binary behind an npm link, with the variables the launcher sets', () => {
      const { pkg, codexPath } = install(join(root, 'npm', 'lib'))
      const bin = join(root, 'npm', 'bin')
      mkdirSync(bin)
      symlinkSync(join(pkg, 'bin', 'codex.js'), join(bin, 'codex'))

      // As the launcher does, a variable inherited from another install is cleared.
      const helper = resolveHelper('codex', { PATH: bin, CODEX_MANAGED_BY_BUN: '1' }, helpersDir(), mac)
      expect(helper.command.endsWith(`/bin/${HELPER_NAME}`)).toBe(true)
      expect(helper.env).toStrictEqual({ PATH: bin, CODEX_MANAGED_PACKAGE_ROOT: pkg, ...managers('NPM') })
      expect(readlinkSync(join(helper.command, '..', '..', 'codex-path'))).toBe(codexPath)
    })

    it('follows a pnpm global shim to the same binary', () => {
      const { pkg } = install(join(root, 'Library', 'pnpm', 'global', '5'))
      const bin = join(root, 'Library', 'pnpm')
      executable(
        join(bin, 'codex'),
        `#!/bin/sh\nexec node "$basedir/global/5/node_modules/@openai/codex/bin/codex.js" "$@"\n# cmd-shim-target=${join(pkg, 'bin', 'codex.js')}\n`,
      )

      const helper = resolveHelper('codex', { PATH: bin }, helpersDir(), mac)
      expect(helper.command.endsWith(`/bin/${HELPER_NAME}`)).toBe(true)
      expect(helper.env).toStrictEqual({ PATH: bin, CODEX_MANAGED_PACKAGE_ROOT: pkg, ...managers('PNPM') })
    })
  })
})
