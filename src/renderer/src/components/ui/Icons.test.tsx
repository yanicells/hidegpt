import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DocsIcon } from './Icons'

describe('DocsIcon', () => {
  it('takes size as the height, with a 3:4 width unless one is given', () => {
    expect(renderToStaticMarkup(<DocsIcon size={32} />)).toMatch(/^<svg width="24" height="32"/)
    expect(renderToStaticMarkup(<DocsIcon size={37} width={27} />)).toMatch(/^<svg width="27" height="37"/)
  })
})
