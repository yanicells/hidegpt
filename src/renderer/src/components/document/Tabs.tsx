import { memo, useCallback, useEffect, useState } from 'react'

import { cn } from '../ui/cn'
import { MIcon } from '../ui/MaterialIcon'
import { Tip } from '../ui/tooltip'
import { sameEntry, type OutlineEntry } from './outline'

const NARROW = '(max-width: 960px)'

/**
 * Docs' "Document tabs" panel: one "Tab 1" pill and the heading outline below
 * it. Questions are Heading 1 and answer sections nest under them, so the
 * outline jumps through the document. The ← collapses the panel to a round
 * button; narrow windows start collapsed. A streamed delta rebuilds the
 * entries but rarely changes one, so the panel re-renders only when it does,
 * and then only the entries that changed.
 */
type TabsProps = {
  entries: ReadonlyArray<OutlineEntry>
  onNew: () => void
  onJump: (entry: OutlineEntry) => void
}

export const Tabs = memo(function Tabs({ entries, onNew, onJump }: TabsProps) {
  const [activeId, setActive] = useState<string | null>(null)
  const [open, setOpen] = useState(() => !window.matchMedia?.(NARROW).matches)
  useEffect(() => {
    const query = window.matchMedia?.(NARROW)
    if (!query) return
    const onChange = () => setOpen(!query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const pick = useCallback(
    (entry: OutlineEntry) => {
      setActive(entry.key)
      onJump(entry)
    },
    [onJump],
  )
  const active =
    activeId && entries.some((entry) => entry.key === activeId)
      ? activeId
      : (entries.filter((entry) => entry.level === 1).pop()?.key ?? null)

  if (!open) {
    return (
      <aside className="tabs collapsed" aria-label="Document tabs" data-testid="outline">
        <Tip label="Show tabs & outlines" side="right">
          <button type="button" className="tabs-show" aria-label="Show tabs & outlines" onClick={() => setOpen(true)}>
            <MIcon name="list" />
          </button>
        </Tip>
      </aside>
    )
  }

  return (
    <aside className="tabs" aria-label="Document tabs" data-testid="outline">
      <Tip label="Hide tabs & outlines">
        <button type="button" className="tabs-hide" aria-label="Hide tabs & outlines" onClick={() => setOpen(false)}>
          <MIcon name="arrow_back" size={24} />
        </button>
      </Tip>
      <div className="tabs-head">
        <span>Document tabs</span>
        <Tip label="Add tab">
          <button type="button" className="tabs-new" aria-label="Add tab" onClick={onNew}>
            <MIcon name="add" />
          </button>
        </Tip>
      </div>
      <div className="tab-pill">
        <MIcon name="article" />
        <span className="tab-pill-name">Tab 1</span>
        <Tip label="Tab options">
          <span className="tab-pill-more" aria-hidden="true">
            <MIcon name="more_vert" />
          </span>
        </Tip>
      </div>
      {entries.length === 0 ? (
        <p className="tabs-hint">Headings you add to the document will appear here.</p>
      ) : (
        <ol className="doc-outline">
          {entries.map((entry) => (
            <OutlineItem key={entry.key} entry={entry} active={active === entry.key} onPick={pick} />
          ))}
        </ol>
      )}
    </aside>
  )
}, sameTabs)
// The build renames a function expression that shadows its binding (`Tabs2`); name it for DevTools and tests.
Tabs.displayName = 'Tabs'

type OutlineItemProps = {
  entry: OutlineEntry
  active: boolean
  onPick: (entry: OutlineEntry) => void
}

/**
 * One outline entry. It compares entries by content: a block gets a new object
 * when text streams into it or when earlier text is loaded above it, and its
 * headings usually stay the same. So a new heading, or a page of earlier
 * turns, renders only the entries that are new or changed.
 */
const OutlineItem = memo(function OutlineItem({ entry, active, onPick }: OutlineItemProps) {
  const text = truncate(entry.text)
  const button = (
    <button
      type="button"
      className={cn('outline-item', entry.level === 2 && 'sub', active && 'active')}
      data-testid={`outline-${entry.key}`}
      aria-current={active ? 'location' : undefined}
      onClick={() => onPick(entry)}
    >
      {text}
    </button>
  )
  // A clipped heading shows in full on hover; the others skip the tooltip's render.
  return (
    <li>
      {text === entry.text ? (
        button
      ) : (
        <Tip label={entry.text} side="right">
          {button}
        </Tip>
      )}
    </li>
  )
}, sameItem)
// The build renames a function expression that shadows its binding (`OutlineItem2`); name it for DevTools and tests.
OutlineItem.displayName = 'OutlineItem'

function sameItem(a: OutlineItemProps, b: OutlineItemProps): boolean {
  return a.active === b.active && a.onPick === b.onPick && sameEntry(a.entry, b.entry)
}

function sameTabs(a: TabsProps, b: TabsProps): boolean {
  return (
    a.onNew === b.onNew &&
    a.onJump === b.onJump &&
    a.entries.length === b.entries.length &&
    a.entries.every((entry, index) => {
      const other = b.entries[index]
      return entry.key === other.key && entry.text === other.text && entry.level === other.level
    })
  )
}

export function truncate(text: string, limit = 48): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single
}
