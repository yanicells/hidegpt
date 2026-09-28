import { memo, useDeferredValue, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { markdownChunks } from './markdownChunks'

const plugins = [remarkGfm]

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
  return <Markdown remarkPlugins={plugins}>{text}</Markdown>
})
