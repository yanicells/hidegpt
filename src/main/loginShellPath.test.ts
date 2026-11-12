import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  type CacheFiles,
  extractPath,
  firstLoginShellPath,
  hydratePath,
  loginShellCandidates,
  pathRefreshed,
  readLoginShellPath,
} from './loginShellPath'

const NVM = '/Users/me/.nvm/versions/node/v24.16.0/bin'

/** Runs `script` in /bin/sh with the probe's spawn options, in place of the login shell. */
function fakeShell(script: string) {
  const spawned: Array<ChildProcess> = []
  const spawnShell = (_file: string, _args: ReadonlyArray<string>, options: SpawnOptions) => {
    const child = spawn('/bin/sh', ['-c', script], options)
    spawned.push(child)
    return child
  }
  return { spawnShell, spawned }
}

/** True once nothing in the probe's process group is left. */
async function groupGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(-pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

describe('readLoginShellPath', () => {
  it('reads PATH between the markers, ignoring what the profile prints around it', () => {
    expect(extractPath(`Welcome back!\n__DOCS_PATH_START__\n${NVM}:/usr/bin\n__DOCS_PATH_END__\nlast login`)).toBe(
      `${NVM}:/usr/bin`,
    )
    expect(extractPath('no markers here')).toBeUndefined()
  })

  it('answers at the end marker and kills a background job the profile left holding stdout', async () => {
    const shell = fakeShell(`sleep 30 & printf '__DOCS_PATH_START__\\n${NVM}\\n__DOCS_PATH_END__\\n'; wait`)
    const startedAt = Date.now()
    await expect(readLoginShellPath('/bin/zsh', 5_000, shell.spawnShell)).resolves.toBe(NVM)
    expect(Date.now() - startedAt).toBeLessThan(1_500)
    expect(await groupGone(shell.spawned[0]!.pid!)).toBe(true)
  })

  it('gives up after the timeout and kills the shell', async () => {
    const shell = fakeShell('sleep 30')
    await expect(readLoginShellPath('/bin/zsh', 150, shell.spawnShell)).resolves.toBeUndefined()
    expect(await groupGone(shell.spawned[0]!.pid!)).toBe(true)
  })

  it('kills a lookup still running when the app quits, and tries no other shell', async () => {
    // A fresh module: the quit is for good, so it must not reach the other tests.
    vi.resetModules()
    const probe = await import('./loginShellPath')
    const shell = fakeShell('sleep 30')
    const lookup = probe.firstLoginShellPath(
      ['/bin/zsh', '/bin/bash'],
      (candidate, timeoutMs) => probe.readLoginShellPath(candidate, timeoutMs, shell.spawnShell),
      1_000,
    )
    probe.killLoginShellProbe()
    await expect(lookup).resolves.toBeUndefined()
    expect(shell.spawned).toHaveLength(1)
    expect(await groupGone(shell.spawned[0]!.pid!)).toBe(true)
  })
})

describe('login shell candidates', () => {
  it('tries $SHELL, then the account shell, then /bin/zsh, without repeats', () => {
    expect(loginShellCandidates({ SHELL: '/opt/homebrew/bin/fish' }, '/bin/bash')).toEqual([
      '/opt/homebrew/bin/fish',
      '/bin/bash',
      '/bin/zsh',
    ])
    expect(loginShellCandidates({ SHELL: '/bin/zsh' }, '/bin/zsh')).toEqual(['/bin/zsh'])
    expect(loginShellCandidates({}, undefined)).toEqual(['/bin/zsh'])
  })

  it('falls through to the next shell until one gives a PATH', async () => {
    const asked: Array<string> = []
    const read = async (shell: string) => {
      asked.push(shell)
      return shell === '/bin/zsh' ? NVM : undefined
    }
    await expect(firstLoginShellPath(['/usr/local/bin/nu', '/bin/zsh', '/bin/bash'], read)).resolves.toBe(NVM)
    expect(asked).toEqual(['/usr/local/bin/nu', '/bin/zsh'])
  })

  it('gives each shell what is left of one 4 s budget', async () => {
    let clock = 0
    const given: Array<[string, number]> = []
    // Each failing shell uses 3 s of the budget.
    const read = async (shell: string, timeoutMs: number) => {
      given.push([shell, timeoutMs])
      clock += Math.min(3_000, timeoutMs)
      return undefined
    }
    await expect(
      firstLoginShellPath(['/bin/fish', '/bin/bash', '/bin/zsh'], read, 4_000, () => clock),
    ).resolves.toBeUndefined()
    expect(given).toEqual([
      ['/bin/fish', 4_000],
      ['/bin/bash', 1_000],
    ])
  })
})

describe('hydratePath', () => {
  const fallback = '/opt/homebrew/bin:/usr/local/bin:/Users/me/.bun/bin:/Users/me/.local/bin:/usr/bin:/bin'
  const CACHE = join('/data', 'login-shell-path.json')
  const NEWER = '/Users/me/.volta/bin'
  const launchEnv = (): NodeJS.ProcessEnv => ({ HOME: '/Users/me', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' })
  const cached = (shell: string, path: string) => JSON.stringify({ version: 1, shell, path })

  /** The cache folder in memory: what is on disk, and how many writes it took. */
  function memoryFiles(initial?: string) {
    const disk = new Map(initial === undefined ? [] : [[CACHE, initial]])
    let writes = 0
    const files: CacheFiles = {
      read: async (file) => {
        const text = disk.get(file)
        if (text === undefined) throw new Error('ENOENT')
        return text
      },
      write: async (file, text) => {
        writes++
        disk.set(file, text)
      },
    }
    return { files, disk, writes: () => writes }
  }

  /** A login shell that answers when the test says, counting how often it was asked. */
  function controlledShell() {
    let answer: (path: string | undefined) => void = () => {}
    let asked = 0
    const findShellPath = () => {
      asked++
      return new Promise<string | undefined>((resolve) => (answer = resolve))
    }
    return { findShellPath, answer: (path: string | undefined) => answer(path), asked: () => asked }
  }

  /** True if `promise` has settled once pending callbacks have run. */
  async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false
    void promise.then(() => (done = true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    return done
  }

  it('a miss waits for the shell once, puts its PATH first, and saves it', async () => {
    const env = launchEnv()
    const { files, disk } = memoryFiles()
    const shell = controlledShell()
    const ready = hydratePath(env, true, '/data', { findShellPath: shell.findShellPath, files })
    expect(env.PATH).toBe(fallback)
    expect(await settled(ready)).toBe(false)
    shell.answer(`${NVM}:/opt/homebrew/bin`)
    await ready
    expect(shell.asked()).toBe(1)
    expect(env.PATH).toBe(`${NVM}:${fallback}`)
    expect(JSON.parse(disk.get(CACHE)!)).toEqual({ version: 1, shell: '/bin/zsh', path: `${NVM}:/opt/homebrew/bin` })
  })

  it('a hit settles on the cached PATH without waiting for the shell, and keeps an unchanged answer as it is', async () => {
    const env = launchEnv()
    const cache = memoryFiles(cached('/bin/zsh', NVM))
    const shell = controlledShell()
    await hydratePath(env, true, '/data', { findShellPath: shell.findShellPath, files: cache.files })
    expect(env.PATH).toBe(`${NVM}:${fallback}`)
    expect(await settled(pathRefreshed())).toBe(false)
    shell.answer(NVM)
    await pathRefreshed()
    expect(shell.asked()).toBe(1)
    expect(env.PATH).toBe(`${NVM}:${fallback}`)
    expect(cache.writes()).toBe(0)
  })

  it("the refresh behind a hit replaces the cached PATH and the file when the shell's answer changed", async () => {
    const env = launchEnv()
    const cache = memoryFiles(cached('/bin/zsh', NVM))
    const shell = controlledShell()
    await hydratePath(env, true, '/data', { findShellPath: shell.findShellPath, files: cache.files })
    shell.answer(NEWER)
    await pathRefreshed()
    // The cached entry is gone, not kept behind the new one.
    expect(env.PATH).toBe(`${NEWER}:${fallback}`)
    expect(JSON.parse(cache.disk.get(CACHE)!)).toEqual({ version: 1, shell: '/bin/zsh', path: NEWER })
  })

  it.each([
    ['another $SHELL', cached('/bin/bash', NVM)],
    ['an unreadable file', '{"version":1,"shell":"/bin/zsh","pa'],
  ])('treats %s as a miss', async (_case, file) => {
    const env = launchEnv()
    const cache = memoryFiles(file)
    const shell = controlledShell()
    const ready = hydratePath(env, true, '/data', { findShellPath: shell.findShellPath, files: cache.files })
    expect(await settled(ready)).toBe(false)
    expect(env.PATH).toBe(fallback)
    shell.answer(NEWER)
    await ready
    expect(env.PATH).toBe(`${NEWER}:${fallback}`)
    expect(JSON.parse(cache.disk.get(CACHE)!)).toEqual({ version: 1, shell: '/bin/zsh', path: NEWER })
  })

  it('never asks a shell in dev, and keeps the fallback and saves nothing when the shell gives nothing', async () => {
    const dev = launchEnv()
    const cache = memoryFiles(cached('/bin/zsh', NVM))
    await hydratePath(dev, false, '/data', {
      findShellPath: () => Promise.reject(new Error('a dev run must not spawn a shell')),
      files: cache.files,
    })
    expect(dev.PATH).toBe(fallback)
    const silent = launchEnv()
    const empty = memoryFiles()
    await hydratePath(silent, true, '/data', { findShellPath: async () => undefined, files: empty.files })
    expect(silent.PATH).toBe(fallback)
    expect(empty.writes()).toBe(0)
  })
})
