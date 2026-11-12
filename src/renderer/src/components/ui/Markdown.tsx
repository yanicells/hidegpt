import type { Components } from 'hast-util-to-jsx-runtime'
import { memo, useDeferredValue } from 'react'
import { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { createMarkdownRenderer } from './markdownRenderer'
import { splitMarkdownBlocks } from './markdownStreamBlocks'

// Links open in the browser: main's window-open handler hands `_blank` links to the OS.
const components: Partial<Components> = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

const render = createMarkdownRenderer({ remarkPlugins: [remarkGfm], components, urlTransform: defaultUrlTransform })

/**
 * Renders an answer block by block. While it streams, only the last block
 * re-parses; finished blocks come from the shared cache, so reopening a
 * document does not parse it again.
 */
export const AgentMarkdown = memo(function AgentMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const deferredText = useDeferredValue(text)
  const blocks = splitMarkdownBlocks(deferredText) ?? [deferredText]
  // A render that still shows an older prefix may end mid-block; only the current text is cached.
  const current = deferredText === text
  return (
    <div className="doc-body">
      {blocks.map((block, index) => (
        // Streamed blocks only change at the end, so the index is a stable key.
        <MarkdownBlock key={index} text={block} cache={current && (!streaming || index < blocks.length - 1)} />
      ))}
    </div>
  )
})

const MarkdownBlock = memo(function MarkdownBlock({ text, cache }: { text: string; cache: boolean }) {
  return render(text, cache)
})
