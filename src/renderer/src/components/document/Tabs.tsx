import { useEffect, useState } from 'react'

import type { Block } from '../../../../codex/blocks'
import { MIcon } from '../ui/MaterialIcon'

const NARROW = '(max-width: 960px)'

/**
 * Docs' "Document tabs" panel: one "Tab 1" pill and the heading outline below
 * it. Each question is a Heading 1, so the outline jumps between turns. The ←
 * collapses the panel to a round button; narrow windows start collapsed.
 */
export function Tabs({
  questions,
  onNew,
  onJump,
}: {
  questions: Extract<Block, { kind: 'user' }>[]
  onNew: () => void
  onJump: (id: string) => void
}) {
  const [activeId, setActive] = useState<string | null>(null)
  const [open, setOpen] = useState(() => !window.matchMedia?.(NARROW).matches)
  useEffect(() => {
    const query = window.matchMedia?.(NARROW)
    if (!query) return
    const onChange = () => setOpen(!query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const active =
    activeId && questions.some((question) => question.id === activeId)
      ? activeId
      : (questions[questions.length - 1]?.id ?? null)

  if (!open) {
    return (
      <aside className="tabs collapsed" aria-label="Document tabs" data-testid="outline">
        <button
          type="button"
          className="tabs-show"
          aria-label="Show tabs & outlines"
          title="Show tabs & outlines"
          onClick={() => setOpen(true)}
        >
          <MIcon name="list" />
        </button>
      </aside>
    )
  }

  return (
    <aside className="tabs" aria-label="Document tabs" data-testid="outline">
      <button
        type="button"
        className="tabs-hide"
        aria-label="Hide tabs & outlines"
        title="Hide tabs & outlines"
        onClick={() => setOpen(false)}
      >
        <MIcon name="arrow_back" size={24} />
      </button>
      <div className="tabs-head">
        <span>Document tabs</span>
        <button type="button" className="tabs-new" aria-label="New document" title="Add tab" onClick={onNew}>
          <MIcon name="add" />
        </button>
      </div>
      <div className="tab-pill">
        <MIcon name="article" />
        <span className="tab-pill-name">Tab 1</span>
        <span className="tab-pill-more" aria-hidden="true" title="Tab options">
          <MIcon name="more_vert" />
        </span>
      </div>
      {questions.length === 0 ? (
        <p className="tabs-hint">Headings you add to the document will appear here.</p>
      ) : (
        <ol className="doc-outline">
          {questions.map((question) => (
            <li key={question.id}>
              <button
                type="button"
                className={`outline-item${active === question.id ? ' active' : ''}`}
                data-testid={`outline-${question.id}`}
                aria-current={active === question.id ? 'location' : undefined}
                title={question.text}
                onClick={() => {
                  setActive(question.id)
                  onJump(question.id)
                }}
              >
                {truncate(question.text) || (question.images ? 'Image' : 'Untitled')}
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}

export function truncate(text: string, limit = 48): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single
}
