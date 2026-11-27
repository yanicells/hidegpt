import { describe, expect, it } from 'vitest'

import { packagedClaudeExecutable } from './executable'

const RESOURCES = '/Applications/Docs.app/Contents/Resources'

describe('packagedClaudeExecutable', () => {
  it('points a packaged personal build at the renamed binary in Resources', () => {
    const exists = (path: string) => path === `${RESOURCES}/Docs Helper`
    expect(packagedClaudeExecutable(RESOURCES, exists)).toBe(`${RESOURCES}/Docs Helper`)
  })

  it("leaves a source checkout, which has no such file, to the SDK's own lookup", () => {
    const electronResources = '/repo/node_modules/electron/dist/Electron.app/Contents/Resources'
    expect(packagedClaudeExecutable(electronResources, () => false)).toBeUndefined()
  })

  it('leaves plain Node, which has no resources path, to the SDK', () => {
    expect(packagedClaudeExecutable(undefined, () => true)).toBeUndefined()
  })
})
