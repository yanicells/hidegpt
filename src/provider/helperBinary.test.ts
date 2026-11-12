import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { HELPER_NAME, resolveHelper } from './helperBinary'

/**
 * Real clones of a real binary: Node itself (`process.execPath`), a signed
 * third-party Mach-O like the provider CLIs. Nothing here starts a provider.
 */
// Real path: macOS's temp folder sits behind a symlink, and clones are keyed by real paths.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'hidegpt-helper-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** macOS checks a new executable on its first launch: seconds for a 100 MB binary on a busy machine. */
const FIRST_LAUNCH = 30_000
const mac = { platform: 'darwin' as const, env: {} }
let count = 0
/** A fresh helpers folder for each test. */
const helpersDir = () => join(root, `helpers-${(count += 1)}`)
/** A clone of Node at `path` (instant on APFS), to stand in for a provider binary. */
const nodeAt = (path: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  copyFileSync(process.execPath, path, constants.COPYFILE_FICLONE)
  return path
}

describe.runIf(process.platform === 'darwin')('resolveHelper', () => {
  it(
    'starts a binary found on PATH as Docs Helper',
    async () => {
      const bin = join(root, 'path-bin')
      mkdirSync(bin)
      symlinkSync(process.execPath, join(bin, 'realtool'))
      const helper = resolveHelper('realtool', { PATH: bin }, helpersDir(), mac)
      expect(helper.command.endsWith(`/${HELPER_NAME}`)).toBe(true)

      const child = spawn(helper.command, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' })
      try {
        await new Promise((resolve) => child.once('spawn', resolve))
        expect(execFileSync('/bin/ps', ['-o', 'ucomm=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()).toBe(
          HELPER_NAME,
        )
      } finally {
        process.kill(child.pid!, 'SIGKILL')
      }
    },
    FIRST_LAUNCH,
  )

  it('links the binary’s siblings and its parent folder’s entries beside the clone', () => {
    const pkg = join(root, 'pkg')
    nodeAt(join(pkg, 'bin', 'tool'))
    writeFileSync(join(pkg, 'bin', 'tool-helper'), '')
    mkdirSync(join(pkg, 'tool-resources'))
    const clone = resolveHelper(join(pkg, 'bin', 'tool'), undefined, helpersDir(), mac).command
    expect(readlinkSync(join(clone, '..', 'tool-helper'))).toBe(join(pkg, 'bin', 'tool-helper'))
    expect(readlinkSync(join(clone, '..', '..', 'tool-resources'))).toBe(join(pkg, 'tool-resources'))
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

  it('starts the original when the clone cannot be made', () => {
    const source = nodeAt(join(root, 'readonly', 'bin', 'tool'))
    const dir = helpersDir()
    mkdirSync(dir)
    chmodSync(dir, 0o500)
    try {
      expect(resolveHelper(source, { A: '1' }, dir, mac)).toEqual({ command: source, env: { A: '1' } })
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('leaves the command alone when off, off macOS, in demo mode, already renamed, or not a binary', () => {
    const source = nodeAt(join(root, 'plain', 'bin', 'tool'))
    const renamed = nodeAt(join(root, 'plain', 'Resources', HELPER_NAME))
    const script = join(root, 'plain', 'bin', 'script')
    writeFileSync(script, '#!/bin/sh\n')
    chmodSync(script, 0o755)
    const dir = helpersDir()
    const unchanged = { command: source, env: undefined }
    expect(resolveHelper(source, undefined, dir, { platform: 'darwin', env: { DOCS_HELPER_RENAME: '0' } })).toEqual(
      unchanged,
    )
    expect(resolveHelper(source, undefined, dir, { platform: 'linux', env: {} })).toEqual(unchanged)
    expect(resolveHelper(source, undefined, null, mac)).toEqual(unchanged)
    expect(resolveHelper(renamed, undefined, dir, mac)).toEqual({ command: renamed, env: undefined })
    expect(resolveHelper(script, undefined, dir, mac)).toEqual({ command: script, env: undefined })
    expect(resolveHelper('hidegpt-no-such-binary', { PATH: join(root, 'plain', 'bin') }, dir, mac).command).toBe(
      'hidegpt-no-such-binary',
    )
    expect(existsSync(dir)).toBe(false)
  })

  it('starts the native binary behind the Codex npm launcher, with the variables the launcher sets', () => {
    const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    const pkg = join(root, 'npm', 'lib', 'node_modules', '@openai', 'codex')
    const platformPkg = join(pkg, 'node_modules', '@openai', `codex-darwin-${process.arch}`)
    mkdirSync(join(pkg, 'bin'), { recursive: true })
    writeFileSync(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n')
    chmodSync(join(pkg, 'bin', 'codex.js'), 0o755)
    nodeAt(join(platformPkg, 'vendor', triple, 'bin', 'codex'))
    writeFileSync(join(platformPkg, 'package.json'), '{"name":"platform"}')
    mkdirSync(join(platformPkg, 'vendor', triple, 'codex-path'))
    const bin = join(root, 'npm', 'bin')
    mkdirSync(bin)
    symlinkSync(join(pkg, 'bin', 'codex.js'), join(bin, 'codex'))

    const helper = resolveHelper('codex', { PATH: bin }, helpersDir(), mac)
    expect(helper.command.endsWith(`/bin/${HELPER_NAME}`)).toBe(true)
    expect(helper.env).toEqual({ PATH: bin, CODEX_MANAGED_PACKAGE_ROOT: pkg, CODEX_MANAGED_BY_NPM: '1' })
    expect(readlinkSync(join(helper.command, '..', '..', 'codex-path'))).toBe(
      join(platformPkg, 'vendor', triple, 'codex-path'),
    )
  })
})
