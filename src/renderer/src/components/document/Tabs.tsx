import { memo, useState } from 'react'

import type { UserBlock } from '../../../../shared/model'
import { dispatch } from '../../session-bridge'
import { BackIcon, KebabIcon, PlusMonoIcon, TabDocIcon } from '../ui/Icons'

type TabsProps = {
  questions: ReadonlyArray<UserBlock>
  onNew: () => void
  onJump: (id: string) => void
}

/**
 * The outline of questions. A streamed delta leaves every question object as
 * it was, so the list re-renders only when a question is added or changed.
 */
export const Tabs = memo(function Tabs({ questions, onNew, onJump }: TabsProps) {
  const [activeId, setActive] = useState<string | null>(null)
  const active =
    activeId && questions.some((question) => question.id === activeId)
      ? (activeId as string)
      : (questions[questions.length - 1]?.id ?? null)
  return (
    <aside className="tabs" aria-label="Document tabs" data-testid="outline">
      <button
        type="button"
        className="tabs-back"
        aria-label="Back to documents"
        onClick={() => dispatch({ op: 'goHome' })}
      >
        <BackIcon />
      </button>
      <div className="tabs-head">
        <span>Document tabs</span>
        <button type="button" className="tabs-new" aria-label="New document" title="New document" onClick={onNew}>
          <PlusMonoIcon />
        </button>
      </div>
      {questions.length === 0 ? (
        <p className="tabs-hint">Questions you ask will appear here.</p>
      ) : (
        <ol className="tabs-list">
          {questions.map((question) => (
            <li key={question.id}>
              <button
                type="button"
                className={`tab${active === question.id ? ' active' : ''}`}
                data-testid={`outline-${question.id}`}
                title={question.text}
                onClick={() => {
                  setActive(question.id)
                  onJump(question.id)
                }}
              >
                <TabDocIcon />
                <span className="tab-text">{truncate(question.text) || (question.images ? 'Image' : 'Untitled')}</span>
                {active === question.id ? <KebabIcon /> : null}
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}, sameTabs)

function sameTabs(a: TabsProps, b: TabsProps): boolean {
  return (
    a.onNew === b.onNew &&
    a.onJump === b.onJump &&
    a.questions.length === b.questions.length &&
    a.questions.every((question, index) => question === b.questions[index])
  )
}

export function truncate(text: string, limit = 48): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single
}
