import { memo } from 'react'
import type { Block } from '../../../../codex/blocks'
import { ChevronIcon } from '../ui/Icons'
import { imageSrc } from '../ui/imageSrc'
import { AgentMarkdown } from '../ui/Markdown'
import { Approval } from './Approval'
import { SkillChip } from './SmartChips'

export const BlockView = memo(
  function BlockView({ block, streaming }: { block: Block; streaming: boolean }) {
    if (block.kind === 'user') {
      return (
        <>
          {block.images?.length ? (
            <div className="doc-images">
              {block.images.map((ref, index) => (
                <span className="doc-image" key={index}>
                  <img src={imageSrc(ref)} alt="" loading="lazy" decoding="async" />
                </span>
              ))}
            </div>
          ) : null}
          {block.text || block.skills?.length ? (
            <p className="doc-question">
              {block.skills?.map((name) => <SkillChip key={name} name={name} />)}
              {block.text}
            </p>
          ) : null}
        </>
      )
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
    if (a.kind === 'user' && b.kind === 'user')
      return a.text === b.text && a.images?.join() === b.images?.join() && a.skills?.join() === b.skills?.join()
    if (a.kind === 'agent' && b.kind === 'agent') return a.text === b.text
    if (a.kind === 'callout' && b.kind === 'callout') return a.title === b.title && a.body === b.body
    return false
  },
)
