import { memo, useDeferredValue } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]

export const AgentMarkdown = memo(function AgentMarkdown({ text }: { text: string }) {
  const deferredText = useDeferredValue(text)
  return (
    <div className="doc-body">
      <Markdown remarkPlugins={plugins}>{deferredText}</Markdown>
    </div>
  )
})
