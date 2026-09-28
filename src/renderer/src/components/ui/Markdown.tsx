import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="doc-body">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  )
}
