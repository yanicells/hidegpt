import { useEffect, useState } from 'react'

import { cn } from '../ui/cn'
import { MIcon } from '../ui/MaterialIcon'
import type { OutlineEntry } from './outline'

const NARROW = '(max-width: 960px)'

/**
 * Docs' "Document tabs" panel: one "Tab 1" pill and the heading outline below
 * it. Questions are Heading 1 and answer sections nest under them, so the
 * outline jumps through the document. The ← collapses the panel to a round
 * button; narrow windows start collapsed.
 */
export function Tabs({
  entries,
  onNew,
  onJump,
}: {
  entries: OutlineEntry[]
  onNew: () => void
  onJump: (entry: OutlineEntry) => void
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
    activeId && entries.some((entry) => entry.key === activeId)
      ? activeId
      : (entries.filter((entry) => entry.level === 1).pop()?.key ?? null)

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
        <button type="button" className="tabs-new" aria-label="Add tab" title="Add tab" onClick={onNew}>
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
      {entries.length === 0 ? (
        <p className="tabs-hint">Headings you add to the document will appear here.</p>
      ) : (
        <ol className="doc-outline">
          {entries.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                className={cn('outline-item', entry.level === 2 && 'sub', active === entry.key && 'active')}
                data-testid={`outline-${entry.key}`}
                aria-current={active === entry.key ? 'location' : undefined}
                title={entry.text}
                onClick={() => {
                  setActive(entry.key)
                  onJump(entry)
                }}
              >
                {truncate(entry.text)}
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
