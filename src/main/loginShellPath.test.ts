import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import {
  extractPath,
  firstLoginShellPath,
  hydratePath,
  killLoginShellProbe,
  loginShellCandidates,
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

  it('kills a lookup still running when the app quits', async () => {
    const shell = fakeShell('sleep 30')
    const lookup = readLoginShellPath('/bin/zsh', 5_000, shell.spawnShell)
    killLoginShellProbe()
    await expect(lookup).resolves.toBeUndefined()
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

  it("sets the fallback at once, then puts a packaged app's shell PATH first", async () => {
    const env: NodeJS.ProcessEnv = { HOME: '/Users/me', PATH: '/usr/bin:/bin' }
    let answer: (path: string) => void = () => {}
    const ready = hydratePath(env, true, () => new Promise((resolve) => (answer = resolve)))
    expect(env.PATH).toBe(fallback)
    answer(`${NVM}:/opt/homebrew/bin`)
    await ready
    expect(env.PATH).toBe(`${NVM}:${fallback}`)
  })

  it('never asks a shell in dev, and keeps the fallback when the shell gives nothing', async () => {
    const dev: NodeJS.ProcessEnv = { HOME: '/Users/me', PATH: '/usr/bin:/bin' }
    await hydratePath(dev, false, () => Promise.reject(new Error('a dev run must not spawn a shell')))
    expect(dev.PATH).toBe(fallback)
    const silent: NodeJS.ProcessEnv = { HOME: '/Users/me', PATH: '/usr/bin:/bin' }
    await hydratePath(silent, true, async () => undefined)
    expect(silent.PATH).toBe(fallback)
  })
})
