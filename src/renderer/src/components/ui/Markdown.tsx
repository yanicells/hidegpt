import { memo, useDeferredValue, useMemo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { markdownChunks } from './markdownChunks'

const plugins = [remarkGfm]

// Links open in the browser: main's window-open handler hands `_blank` links to the OS.
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

/** Renders an answer chunk by chunk; unchanged chunks skip re-parsing while text streams in. */
export const AgentMarkdown = memo(function AgentMarkdown({ text }: { text: string }) {
  const deferredText = useDeferredValue(text)
  const chunks = useMemo(() => markdownChunks(deferredText), [deferredText])
  return (
    <div className="doc-body">
      {chunks.map((chunk, index) => (
        <MarkdownChunk key={index} text={chunk} />
      ))}
    </div>
  )
})

const MarkdownChunk = memo(function MarkdownChunk({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={plugins} components={components}>
      {text}
    </Markdown>
  )
})
