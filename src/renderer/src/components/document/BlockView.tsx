import { memo, useDeferredValue } from 'react'
import type { Block } from '../../../../shared/model'
import { imageSrc } from '../ui/imageSrc'
import { useMarkdown } from '../ui/loadMarkdown'
import { MIcon } from '../ui/MaterialIcon'
import { Approval } from './Approval'
import { SkillChip } from './SmartChips'
import { revealedText } from './streamReveal'

export const BlockView = memo(
  function BlockView({ block, streaming }: { block: Block; streaming: boolean }) {
    if (block.kind === 'user') {
      return (
        <>
          {block.images?.length ? (
            <div className="doc-images">
              {block.images.map((ref, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- a sent turn's images never reorder, and may repeat
                <span className="doc-image" key={index}>
                  <img src={imageSrc(ref)} alt="" loading="lazy" decoding="async" />
                </span>
              ))}
            </div>
          ) : null}
          {block.text || block.skills?.length ? (
            // Each question is the turn's Heading 1, as Docs would title a section.
            <h1 className="doc-question">
              {block.skills?.map((name) => (
                <SkillChip key={name} name={name} />
              ))}
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

/**
 * An answer. While it streams, only its finished lines show, and the cursor
 * waits on the writing line below them, where the next line will land.
 */
function AgentBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const markdown = useMarkdown()
  // Deferred here, so the writing line stays until the last lines replace it in the same
  // commit; dropping it a frame early would move the page up and back down.
  const shown = useDeferredValue(streaming ? revealedText(text) : text)
  const writing = streaming || shown !== text
  return (
    <div className={writing ? 'streaming' : undefined}>
      {markdown ? (
        <markdown.AgentMarkdown text={shown} streaming={writing} />
      ) : (
        // The renderer loads after the first paint; until then the text shows as written.
        <div className="doc-body" style={{ whiteSpace: 'pre-wrap' }}>
          {shown}
        </div>
      )}
      {writing ? (
        <p className="writing-line" aria-hidden="true">
          <span className="caret" />
        </p>
      ) : null}
    </div>
  )
}
