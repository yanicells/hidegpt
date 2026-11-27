import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  askLoginShell,
  type CacheFiles,
  extractPath,
  firstLoginShellPath,
  hydratePath,
  type LoginShellPath,
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
    await expect(firstLoginShellPath(['/usr/local/bin/nu', '/bin/zsh', '/bin/bash'], read)).resolves.toEqual({
      path: NVM,
      shell: '/bin/zsh',
    })
    expect(asked).toEqual(['/usr/local/bin/nu', '/bin/zsh'])
  })

  it("counts only $SHELL and the account shell as the person's own, not the /bin/zsh fallback", async () => {
    const answeredBy = (shell: string) => async () => ({ path: NVM, shell })
    const env = { SHELL: '/opt/homebrew/bin/fish' }
    await expect(askLoginShell(env, '/bin/bash', answeredBy('/opt/homebrew/bin/fish'))).resolves.toEqual({
      path: NVM,
      fromUserShell: true,
    })
    await expect(askLoginShell(env, '/bin/bash', answeredBy('/bin/bash'))).resolves.toEqual({
      path: NVM,
      fromUserShell: true,
    })
    await expect(askLoginShell(env, '/bin/bash', answeredBy('/bin/zsh'))).resolves.toEqual({
      path: NVM,
      fromUserShell: false,
    })
    // /bin/zsh is theirs when it is their $SHELL.
    await expect(askLoginShell({ SHELL: '/bin/zsh' }, undefined, answeredBy('/bin/zsh'))).resolves.toEqual({
      path: NVM,
      fromUserShell: true,
    })
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
  const entry = (path: string, shell = '/bin/zsh', zdotdir = '') => ({ version: 1, shell, zdotdir, path })
  const cached = (path: string, shell?: string, zdotdir?: string) => JSON.stringify(entry(path, shell, zdotdir))
  /** An answer from the person's own shell, and one from the /bin/zsh fallback. */
  const own = (path: string): LoginShellPath => ({ path, fromUserShell: true })
  const fallbackShell = (path: string): LoginShellPath => ({ path, fromUserShell: false })

  /** The cache folder in memory: what is on disk, and how many writes it took. */
  function memoryFiles(initial?: string | Error, write?: CacheFiles['write']) {
    const disk = new Map(typeof initial === 'string' ? [[CACHE, initial]] : [])
    let writes = 0
    const files: CacheFiles = {
      read: async (file) => {
        if (initial instanceof Error) throw initial
        const text = disk.get(file)
        if (text === undefined) throw new Error('ENOENT')
        return text
      },
      write: async (file, text) => {
        writes++
        if (write) return write(file, text)
        disk.set(file, text)
      },
    }
    return { files, saved: () => JSON.parse(disk.get(CACHE) ?? 'null'), writes: () => writes }
  }

  /** A login shell that answers when the test says, counting how often it was asked. */
  function controlledShell() {
    let answer: (path: LoginShellPath | undefined) => void = () => {}
    let asked = 0
    const findShellPath = () => {
      asked++
      return new Promise<LoginShellPath | undefined>((resolve) => (answer = resolve))
    }
    return { findShellPath, answer: (path: LoginShellPath | undefined) => answer(path), asked: () => asked }
  }

  /** True if `promise` has settled once pending callbacks have run. */
  async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false
    void promise.then(() => (done = true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    return done
  }

  /** A packaged launch on `cache`, settled on the cached PATH, with the shell still to answer. */
  async function hit(cache: ReturnType<typeof memoryFiles>, warn?: (message: string) => void) {
    const env = launchEnv()
    const shell = controlledShell()
    await hydratePath(env, true, '/data', { findShellPath: shell.findShellPath, files: cache.files, warn })
    return { env, shell }
  }

  it('a miss waits for the shell once, puts its PATH first, and saves it', async () => {
    const env = launchEnv()
    const cache = memoryFiles()
    const shell = controlledShell()
    const ready = hydratePath(env, true, '/data', { findShellPath: shell.findShellPath, files: cache.files })
    expect(env.PATH).toBe(fallback)
    expect(await settled(ready)).toBe(false)
    shell.answer(own(`${NVM}:/opt/homebrew/bin`))
    await ready
    expect(shell.asked()).toBe(1)
    expect(env.PATH).toBe(`${NVM}:${fallback}`)
    expect(cache.saved()).toEqual(entry(`${NVM}:/opt/homebrew/bin`))
  })

  it('a hit settles on the cached PATH without waiting for the shell, and keeps an unchanged answer as it is', async () => {
    const cache = memoryFiles(cached(NVM))
    const { env, shell } = await hit(cache)
    expect(env.PATH).toBe(`${NVM}:${fallback}`)
    expect(await settled(pathRefreshed())).toBe(false)
    shell.answer(own(NVM))
    await pathRefreshed()
    expect(shell.asked()).toBe(1)
    expect(env.PATH).toBe(`${NVM}:${fallback}`)
    expect(cache.writes()).toBe(0)
  })

  it("the refresh behind a hit replaces the cached PATH and the file when the person's shell answers differently", async () => {
    const cache = memoryFiles(cached(NVM))
    const { env, shell } = await hit(cache)
    shell.answer(own(NEWER))
    await pathRefreshed()
    // The cached entry is gone, not kept behind the new one.
    expect(env.PATH).toBe(`${NEWER}:${fallback}`)
    expect(cache.saved()).toEqual(entry(NEWER))
  })

  it('a hit keeps the cached PATH and file when only the /bin/zsh fallback answers', async () => {
    const cache = memoryFiles(cached(NVM))
    const { env, shell } = await hit(cache)
    shell.answer(fallbackShell(NEWER))
    await pathRefreshed()
    expect(env.PATH).toBe(`${NEWER}:${NVM}:${fallback}`)
    expect(cache.writes()).toBe(0)
  })

  it('a hit keeps the cached PATH and file when the refresh gives nothing', async () => {
    const cache = memoryFiles(cached(NVM))
    const { env, shell } = await hit(cache)
    shell.answer(undefined)
    await pathRefreshed()
    expect(env.PATH).toBe(`${NVM}:${fallback}`)
    expect(cache.writes()).toBe(0)
  })

  it('the refresh settles once PATH is set, without waiting for the file write', async () => {
    const cache = memoryFiles(cached(NVM), () => new Promise(() => {}))
    const { env, shell } = await hit(cache)
    shell.answer(own(NEWER))
    expect(await settled(pathRefreshed())).toBe(true)
    expect(env.PATH).toBe(`${NEWER}:${fallback}`)
    expect(cache.writes()).toBe(1)
  })

  it('says a cache write failed, without naming PATH', async () => {
    const warnings: Array<string> = []
    const cache = memoryFiles(cached(NVM), () => Promise.reject(new Error('EACCES')))
    const { shell } = await hit(cache, (message) => warnings.push(message))
    shell.answer(own(NEWER))
    await settled(pathRefreshed())
    expect(warnings).toEqual(['Could not cache the login shell PATH'])
  })

  it.each([
    ['another $SHELL', cached(NVM, '/bin/bash')],
    ['another ZDOTDIR', cached(NVM, '/bin/zsh', '/Users/me/.config/zsh')],
    ['a truncated file', '{"version":1,"shell":"/bin/zsh","pa'],
    ['a file it cannot read', new Error('EACCES')],
  ])('treats %s as a miss', async (_case, file) => {
    const env = launchEnv()
    const cache = memoryFiles(file)
    const shell = controlledShell()
    const ready = hydratePath(env, true, '/data', { findShellPath: shell.findShellPath, files: cache.files })
    expect(await settled(ready)).toBe(false)
    expect(env.PATH).toBe(fallback)
    shell.answer(own(NEWER))
    await ready
    expect(env.PATH).toBe(`${NEWER}:${fallback}`)
    expect(cache.writes()).toBe(1)
  })

  it('never asks a shell in dev, and keeps the fallback and saves nothing when the shell gives nothing', async () => {
    const dev = launchEnv()
    const cache = memoryFiles(cached(NVM))
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
