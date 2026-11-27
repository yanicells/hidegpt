import { afterEach, describe, expect, it, vi } from 'vitest'

import { fontRows, fontStack } from './components/document/toolbarMenus'
import { addFontMenuFaces } from './fontMenu'

/** Faces the menu can draw without fontMenu.ts: Roboto ships in fonts.ts, the rest come with macOS. */
const ELSEWHERE = [
  'Roboto',
  'Arial',
  'Comic Sans MS',
  'Courier New',
  'Georgia',
  'Impact',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
]

/** Calibri and Cambria draw with their metric-compatible stand-ins. */
const STAND_INS: Record<string, string> = { Calibri: 'Carlito', Cambria: 'Caladea' }

afterEach(() => vi.unstubAllGlobals())

describe('addFontMenuFaces', () => {
  it('gives every font menu row its own face', () => {
    const added: { family: string; source: string; descriptors: FontFaceDescriptors }[] = []
    // `new` on a plain function: the constructor's arguments are all the test needs.
    vi.stubGlobal('FontFace', function (family: string, source: string, descriptors: FontFaceDescriptors) {
      added.push({ family, source, descriptors })
    })
    vi.stubGlobal('document', { fonts: { add: () => undefined } })

    addFontMenuFaces()

    for (const { family, source, descriptors } of added) {
      expect(source, family).toMatch(/^url\(".+\.woff2"\) format\('woff2'\)$/)
      expect(descriptors).toEqual({ weight: '400', display: 'swap' })
    }
    const families = new Set([...added.map((face) => face.family), ...ELSEWHERE])
    for (const { font } of fontRows([])) {
      const face = fontStack(font)
        .split(',')
        .map((name) => name.trim().replace(/'/g, ''))
        .find((name) => families.has(name))
      expect(face, font).toBe(STAND_INS[font] ?? font)
    }
  })
})
