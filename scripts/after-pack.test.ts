import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AfterPackContext } from 'electron-builder'
import { afterEach, describe, expect, it } from 'vitest'

import { afterPack, nameHelpers } from './after-pack.ts'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('nameHelpers', () => {
  it("sets every helper app's bundle name to its own name, and touches nothing else", () => {
    dir = mkdtempSync(join(tmpdir(), 'docs-after-pack-'))
    const frameworks = join(dir, 'Docs.app', 'Contents', 'Frameworks')
    for (const entry of ['Docs Helper.app', 'Docs Helper (GPU).app', 'Electron Framework.framework']) {
      mkdirSync(join(frameworks, entry), { recursive: true })
    }

    const set: Array<[string, string]> = []
    nameHelpers(join(dir, 'Docs.app'), (plist, name) => set.push([plist, name]))

    expect(set.sort()).toEqual([
      [join(frameworks, 'Docs Helper (GPU).app', 'Contents', 'Info.plist'), 'Docs Helper (GPU)'],
      [join(frameworks, 'Docs Helper.app', 'Contents', 'Info.plist'), 'Docs Helper'],
    ])
  })
})

describe('afterPack', () => {
  /** The parts of electron-builder's context the hook reads. */
  type Context = Pick<AfterPackContext, 'electronPlatformName' | 'appOutDir'> & {
    packager: { appInfo: { productFilename: string } }
  }
  const context = (electronPlatformName: string, appOutDir: string): Context => ({
    electronPlatformName,
    appOutDir,
    packager: { appInfo: { productFilename: 'Docs' } },
  })

  it('names the helpers of the app it finds from the output folder and product name', async () => {
    dir = mkdtempSync(join(tmpdir(), 'docs-after-pack-'))
    const frameworks = join(dir, 'Docs.app', 'Contents', 'Frameworks')
    mkdirSync(join(frameworks, 'Docs Helper.app'), { recursive: true })

    const set: Array<[string, string]> = []
    await afterPack(context('darwin', dir) as AfterPackContext, (plist, name) => set.push([plist, name]))

    expect(set).toEqual([[join(frameworks, 'Docs Helper.app', 'Contents', 'Info.plist'), 'Docs Helper']])
  })

  it('leaves a build for another platform alone', async () => {
    // A missing folder: reading its Frameworks would throw if the hook went ahead.
    const missing = join(tmpdir(), 'docs-after-pack-missing')
    await expect(afterPack(context('linux', missing) as AfterPackContext)).resolves.toBeUndefined()
  })
})
