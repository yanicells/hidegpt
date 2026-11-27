// The guard patches child_process for the whole process, so it runs in a Node subprocess,
// as T3 Code tests its startup-profiling preload (scripts/profile-startup.test.ts).
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

const guard = join(import.meta.dirname, 'spawn-guard.cjs')

it('runs the fake for codex, and refuses and records any other program', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bench-spawn-guard-'))
  try {
    const fake = join(directory, 'fake')
    writeFileSync(fake, '#!/bin/sh\necho "fake $*"\n')
    chmodSync(fake, 0o755)
    // The ESM namespace is loaded first, as in Electron, so the guard must update its bindings.
    const script = `
      import('node:child_process').then((esm) => {
        const childProcess = require('node:child_process')
        const blocked = require(${JSON.stringify(guard)}).installSpawnGuard(childProcess, ${JSON.stringify(fake)})
        const codex = childProcess.spawnSync('/usr/local/bin/codex', ['app-server'], { encoding: 'utf8' }).stdout.trim()
        const git = childProcess.spawnSync('git', ['--version']).error?.code
        let opencode = null
        try { childProcess.execFileSync('opencode', ['serve']) } catch (error) { opencode = error.code }
        const claude = esm.spawnSync('claude').error?.code
        console.log(JSON.stringify({ codex, git, opencode, claude, blocked }))
      })
    `
    const out = JSON.parse(
      execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }),
    )
    expect(out).toEqual({
      codex: 'fake app-server',
      git: 'ENOENT',
      opencode: 'ENOENT',
      claude: 'ENOENT',
      blocked: ['git', 'opencode', 'claude'],
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
