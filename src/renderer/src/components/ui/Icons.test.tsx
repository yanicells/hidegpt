import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DocsIcon } from './Icons'

describe('DocsIcon', () => {
  it('keeps size as a square box with the logo where the old one sat', () => {
    expect(renderToStaticMarkup(<DocsIcon size={40} />)).toMatch(/^<svg width="40" height="40" viewBox="-8 -3 40 40"/)
  })

  it('takes height for the artwork alone, with a 3:4 width unless one is given', () => {
    expect(renderToStaticMarkup(<DocsIcon height={32} />)).toMatch(/^<svg width="24" height="32"/)
    expect(renderToStaticMarkup(<DocsIcon height={37} width={27} />)).toMatch(/^<svg width="27" height="37"/)
  })
})
