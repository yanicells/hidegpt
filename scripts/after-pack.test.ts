import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AfterPackContext } from 'electron-builder'
import { afterEach, describe, expect, it } from 'vitest'

import { afterPack, nameHelpers } from './after-pack.ts'

describe('nameHelpers', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

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
  it('leaves a build for another platform alone', async () => {
    // A missing folder: reading its Frameworks would throw if the hook went ahead.
    const context = {
      electronPlatformName: 'linux',
      appOutDir: join(tmpdir(), 'docs-after-pack-missing'),
      packager: { appInfo: { productFilename: 'Docs' } },
    } as unknown as AfterPackContext
    await expect(afterPack(context)).resolves.toBeUndefined()
  })
})
