import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { dropWoffSources } from './woff2-only.ts'

const require = createRequire(import.meta.url)
const fontsourceCss = (path: string) => readFileSync(require.resolve(path), 'utf8')

describe('dropWoffSources', () => {
  it('keeps every face and its .woff2 source, and no .woff', () => {
    const css = fontsourceCss('@fontsource/roboto/400.css')
    const faces = css.match(/@font-face/g)?.length
    const woff2 = css.match(/\.woff2\) format\('woff2'\)/g)?.length
    expect(css).toMatch(/\.woff\)/)

    const out = dropWoffSources(css)
    expect(out).not.toMatch(/\.woff\)/)
    expect(out.match(/@font-face/g)?.length).toBe(faces)
    expect(out.match(/\.woff2\) format\('woff2'\)/g)?.length).toBe(woff2)
    expect(out).toContain("src: url(./files/roboto-latin-400-normal.woff2) format('woff2');")
  })

  it('leaves a woff2-only variable package unchanged', () => {
    const css = fontsourceCss('@fontsource-variable/google-sans-flex/opsz.css')
    expect(dropWoffSources(css)).toBe(css)
  })
})
