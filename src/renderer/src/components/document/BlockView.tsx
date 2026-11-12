import { memo } from 'react'
import type { Block } from '../../../../shared/model'
import { imageSrc } from '../ui/imageSrc'
import { useMarkdown } from '../ui/loadMarkdown'
import { MIcon } from '../ui/MaterialIcon'
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
            // Each question is the turn's Heading 1, as Docs would title a section.
            <h1 className="doc-question">
              {block.skills?.map((name) => <SkillChip key={name} name={name} />)}
              {block.text}
            </h1>
          ) : null}
        </>
      )
    }
    if (block.kind === 'agent') return <AgentBlock text={block.text} streaming={streaming} />
    if (block.kind === 'callout') {
      return (
        <details className="callout">
          <summary>
            <MIcon name="arrow_right" className="callout-arrow" />
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

function AgentBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const markdown = useMarkdown()
  return (
    <div className={streaming ? 'streaming' : undefined}>
      {markdown ? (
        <markdown.AgentMarkdown text={text} streaming={streaming} />
      ) : (
        // The renderer loads after the first paint; until then the text shows as written.
        <div className="doc-body" style={{ whiteSpace: 'pre-wrap' }}>
          {text}
        </div>
      )}
      {streaming ? <span className="caret" /> : null}
    </div>
  )
}
