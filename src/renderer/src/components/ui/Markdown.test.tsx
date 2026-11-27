/** @vitest-environment jsdom */

import { cleanup, render } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentMarkdown } from './Markdown'
import { scanMarkdownBlocks, splitMarkdownBlocks } from './markdownStreamBlocks'

const markdownCalls = vi.hoisted(() => ({ count: 0 }))

// Counts every Markdown render the component asks for; the output is the real renderer's.
vi.mock('./markdownRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./markdownRenderer')>()
  return {
    createMarkdownRenderer: (options: Parameters<typeof actual.createMarkdownRenderer>[0]) => {
      const renderer = actual.createMarkdownRenderer(options)
      return {
        ...renderer,
        markdown: (text: string, cache: boolean) => {
          markdownCalls.count++
          return renderer.markdown(text, cache)
        },
      }
    },
  }
})

afterEach(cleanup)

// Each block through react-markdown, as the page shows it; with `closer`, the last block closed by it.
function markdownHtml(text: string, closer?: string) {
  const blocks = splitMarkdownBlocks(text) ?? [text]
  const eol = text.includes('\r') ? '\r\n' : '\n'
  const close = (block: string) =>
    closer === undefined ? block : block + (block.endsWith('\n') ? '' : block.endsWith('\r') ? '\n' : eol) + closer
  const { container } = render(
    <div className="doc-body">
      {blocks.map((block, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- a fixed list
        <ReactMarkdown key={index} remarkPlugins={[remarkGfm]}>
          {index === blocks.length - 1 ? close(block) : block}
        </ReactMarkdown>
      ))}
    </div>,
  )
  const html = container.innerHTML
  container.remove()
  return html
}

describe('AgentMarkdown', () => {
  it.each([
    { text: 'Intro\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n', opener: '```', closer: '```', fast: true },
    { text: '```\nplain  \n  text\n \n', opener: '```', closer: '```', fast: true },
    { text: '```ts title="a&b"\nx\n', opener: '```', closer: '```', fast: true },
    { text: 'a\n\n~~~~ py x\nprint(1)\n~~~\n```\n', opener: '~~~~', closer: '~~~~', fast: true },
    { text: '  ```js\n  a\n   \n    b\n   c\n', opener: '```', closer: '```', fast: true },
    { text: '```\n\tx\na\u0000b\n', opener: '```', closer: '```', fast: true },
    { text: '- item\n\n  ```ts\n  a\n\n  b\n', opener: '```', closer: '  ```', fast: false },
    { text: 'Intro\r\n\r\n```ts\r\na\r\n\r\nb\r\n', opener: '```', closer: '```', fast: false },
    { text: '```c\\+\\+\nint x;\n', opener: '```', closer: '```', fast: false },
    { text: '  ```\n\tx\n', opener: '```', closer: '```', fast: false },
  ])('streams an open fence as the code block it closes into: $text', ({ text, opener, closer, fast }) => {
    // The others keep the Markdown path, which inside a list drops an open fence's trailing blank line.
    expect(scanMarkdownBlocks(text)?.openCode != null).toBe(fast)
    const view = render(<AgentMarkdown text="" streaming />)
    for (let end = text.indexOf(opener) + opener.length; end <= text.length; end++) {
      const source = text.slice(0, end)
      view.rerender(<AgentMarkdown text={source} streaming />)
      expect(view.container.innerHTML, JSON.stringify(source)).toBe(markdownHtml(source, fast ? closer : undefined))
    }
  })

  it('does not parse a code block while it streams, and keeps its element when it closes', () => {
    let text = 'Here is the full file:\n\n```ts\n'
    const view = render(<AgentMarkdown text={text} streaming />)
    markdownCalls.count = 0
    for (let line = 0; line < 240; line++) {
      text += `export const value${line} = ${line}\n`
      view.rerender(<AgentMarkdown text={text} streaming />)
    }
    expect(markdownCalls.count).toBe(0)
    const code = view.container.querySelector('code')
    expect(code?.textContent).toContain('value239 = 239\n')

    view.rerender(<AgentMarkdown text={`${text}\`\`\``} streaming />)
    expect(markdownCalls.count).toBeGreaterThan(0)
    expect(view.container.querySelector('code')).toBe(code)
    expect(view.container.innerHTML).toBe(markdownHtml(`${text}\`\`\``))
  })
})
