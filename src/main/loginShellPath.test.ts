import { describe, expect, it } from 'vitest'

import { extractPath, launchPath, pathCaptureCommand, readLoginShellPath } from './loginShellPath'

const NVM = '/Users/me/.nvm/versions/node/v24.16.0/bin'
const env = { HOME: '/Users/me', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }

describe('login shell PATH', () => {
  it('reads PATH between the markers, ignoring what the profile prints around it', () => {
    let ran: ReadonlyArray<string> = []
    const shell = (file: string, args: ReadonlyArray<string>) => {
      ran = [file, ...args]
      return `Welcome back!\n__DOCS_PATH_START__\n${NVM}:/usr/bin\n__DOCS_PATH_END__\nlast login`
    }
    expect(readLoginShellPath('/bin/zsh', shell)).toBe(`${NVM}:/usr/bin`)
    expect(ran).toEqual(['/bin/zsh', '-ilc', pathCaptureCommand('/bin/zsh')])
    expect(extractPath('no markers here')).toBeUndefined()
  })

  it('treats a failing or timed-out shell as no answer', () => {
    const timedOut = () => {
      throw Object.assign(new Error('spawnSync /bin/zsh ETIMEDOUT'), { code: 'ETIMEDOUT' })
    }
    expect(readLoginShellPath('/bin/zsh', timedOut)).toBeUndefined()
  })

  it("puts a packaged app's shell PATH first, then the fallback folders, without repeats", () => {
    expect(launchPath(env, true, () => `${NVM}:/opt/homebrew/bin:/usr/bin`)).toBe(
      `${NVM}:/opt/homebrew/bin:/usr/bin:/usr/local/bin:/Users/me/.bun/bin:/Users/me/.local/bin:/bin`,
    )
  })

  it('falls back to the usual folders when the shell gives nothing, and never asks it in dev', () => {
    const fallback = '/opt/homebrew/bin:/usr/local/bin:/Users/me/.bun/bin:/Users/me/.local/bin:/usr/bin:/bin'
    expect(launchPath(env, true, () => undefined)).toBe(fallback)
    expect(
      launchPath(env, false, () => {
        throw new Error('a dev run must not spawn a shell')
      }),
    ).toBe(fallback)
  })
})
