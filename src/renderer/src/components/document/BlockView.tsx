import type { Block } from '../../../../codex/blocks'
import { ChevronIcon } from '../ui/Icons'
import { AgentMarkdown } from '../ui/Markdown'
import { Approval } from './Approval'

export function BlockView({ block, streaming }: { block: Block; streaming: boolean }) {
  if (block.kind === 'user') {
    return <p className="doc-question">{block.text}</p>
  }
  if (block.kind === 'agent') {
    return (
      <div className={streaming ? 'streaming' : undefined}>
        <AgentMarkdown text={block.text} />
        {streaming ? <span className="caret" /> : null}
      </div>
    )
  }
  if (block.kind === 'callout') {
    return (
      <details className="callout">
        <summary>
          <ChevronIcon />
          {block.title}
        </summary>
        {block.body ? <pre>{block.body}</pre> : null}
      </details>
    )
  }
  return <Approval block={block} />
}
