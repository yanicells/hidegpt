import { memo } from 'react'
import type { Block } from '../../../../codex/blocks'
import { ChevronIcon } from '../ui/Icons'
import { AgentMarkdown } from '../ui/Markdown'
import { Approval } from './Approval'

export const BlockView = memo(
  function BlockView({ block, streaming }: { block: Block; streaming: boolean }) {
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
  },
  (previous, next) => {
    if (previous.streaming !== next.streaming) return false
    const a = previous.block,
      b = next.block
    if (a === b) return true
    if (a.id !== b.id || a.kind !== b.kind) return false
    if ((a.kind === 'user' || a.kind === 'agent') && (b.kind === 'user' || b.kind === 'agent')) return a.text === b.text
    if (a.kind === 'callout' && b.kind === 'callout') return a.title === b.title && a.body === b.body
    return false
  },
)
