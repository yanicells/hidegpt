// Adapted from T3 Code (apps/web/src/components/chat/markdownRenderer.test.tsx) at commit 8a14762c.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'

import { createMarkdownRenderer } from './markdownRenderer'

// Visible in the markup, so every URL attribute must pass through it.
const urlTransform = (url: string) => `${url}#seen`

describe('createMarkdownRenderer', () => {
  const render = createMarkdownRenderer({ remarkPlugins: [remarkGfm], components: {}, urlTransform })

  it.each([
    '# Title\n\nText with `code`, **bold**, [a link](https://example.com "t") and https://bare.example.com.',
    '![shot](./shot.png) and [file](file:///C:/repo/a.ts) and [bad](javascript:alert(1))',
    '<details><summary>More</summary>\n\nHidden <b>bold</b> <script>x()</script>\n\n</details>',
    '| a | b |\n| - | - |\n| <br> | [x](#frag) |\n\n- [ ] task\n- [x] done',
    '```ts title="a.ts"\nconst a = 1;\n```\n\n> careful <a>bare</a>',
    'Footnote[^1] and ~~strike~~\n\n[^1]: the note',
    'Mail me@example.com, see www.example.com and HTTPS://example.com/a, not [x](https://y.z).',
  ])('renders what react-markdown renders: %j', (source) => {
    const expected = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform}>
        {source}
      </ReactMarkdown>,
    )
    const element = render(source, true)
    expect(renderToStaticMarkup(element)).toBe(expected)
    expect(render(source, true)).toBe(element)
  })

  it('keeps cached answers when one far larger than the cache is rendered', () => {
    const element = render('Kept *answer*', true)
    render('x'.repeat(600_000), true)
    expect(render('Kept *answer*', true)).toBe(element)
  })
})
