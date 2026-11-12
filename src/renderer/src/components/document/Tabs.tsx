import { memo, useEffect, useRef, useState, type RefObject } from 'react'

import { cn } from '../ui/cn'
import { MIcon } from '../ui/MaterialIcon'
import { Tip } from '../ui/tooltip'
import { outlineTarget, sectionAt, type OutlineEntry } from './outline'

const NARROW = '(max-width: 960px)'
// The reading line, 10% down the canvas: the active section is the one holding it.
// The observed area runs from far above the canvas down to that line, so a heading
// crossing it in either direction (or a jump past it) changes its intersection.
const READING_LINE = '1000000px 0px -90% 0px'

/**
 * Docs' "Document tabs" panel: one "Tab 1" pill and the heading outline below
 * it. Questions are Heading 1 and answer sections nest under them, so the
 * outline jumps through the document. The active item is the section at the
 * top of the canvas, or the one you just clicked until you scroll. The ←
 * collapses the panel to a round button; narrow windows start collapsed. A
 * streamed delta rebuilds the entries but rarely changes one, so the panel
 * re-renders only when it does, or when a heading crosses the reading line.
 */
type TabsProps = {
  entries: ReadonlyArray<OutlineEntry>
  onNew: () => void
  onJump: (entry: OutlineEntry) => void
}

export const Tabs = memo(function Tabs({ entries, onNew, onJump }: TabsProps) {
  const panelRef = useRef<HTMLElement>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const [open, setOpen] = useState(() => !window.matchMedia?.(NARROW).matches)
  const reading = useReadingSection(panelRef, entries, open)
  useEffect(() => {
    const query = window.matchMedia?.(NARROW)
    if (!query) return
    const onChange = () => setOpen(!query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  // A clicked item stays active through its smooth scroll, and where the
  // document can't scroll its heading to the top, until you scroll yourself.
  useEffect(() => {
    if (!pinned) return
    const controller = new AbortController()
    const release = () => setPinned(null)
    for (const type of ['wheel', 'pointerdown', 'keydown'] as const) {
      window.addEventListener(type, release, { signal: controller.signal, passive: true })
    }
    return () => controller.abort()
  }, [pinned])
  const known = (key: string | null) => key !== null && entries.some((entry) => entry.key === key)
  // Without an observer (or before its first report) the latest question is active.
  const active = known(pinned)
    ? pinned
    : known(reading)
      ? reading
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
    <aside className="tabs" aria-label="Document tabs" data-testid="outline" ref={panelRef}>
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
            <li key={entry.key}>
              {/* A clipped heading shows in full on hover. */}
              <Tip label={truncate(entry.text) === entry.text ? undefined : entry.text} side="right">
                <button
                  type="button"
                  className={cn('outline-item', entry.level === 2 && 'sub', active === entry.key && 'active')}
                  data-testid={`outline-${entry.key}`}
                  aria-current={active === entry.key ? 'location' : undefined}
                  onClick={() => {
                    setPinned(entry.key)
                    onJump(entry)
                  }}
                >
                  {truncate(entry.text)}
                </button>
              </Tip>
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
    a.entries.length === b.entries.length &&
    a.entries.every((entry, index) => {
      const other = b.entries[index]
      return entry.key === other.key && entry.text === other.text && entry.level === other.level
    })
  )
}

/**
 * The key of the section at the reading line of the canvas that holds `panel`,
 * or null until the observer first reports. The observer calls back only when
 * a heading crosses the line, and each call reads one box per heading.
 */
function useReadingSection(
  panel: RefObject<HTMLElement | null>,
  entries: ReadonlyArray<OutlineEntry>,
  open: boolean,
): string | null {
  const [key, setKey] = useState<string | null>(null)
  useEffect(() => {
    const root = panel.current?.closest<HTMLElement>('.workspace')
    if (!open || !root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (records) => {
        const line = records[0]?.rootBounds?.bottom
        if (line === undefined) return
        // Headings can render after the panel (late rows, lazy Markdown), so each
        // report looks them up again and watches any new ones.
        const targets = entries.map((entry) => outlineTarget(root, entry))
        for (const target of targets) if (target) observer.observe(target)
        const tops = targets.map((target) => target?.getBoundingClientRect().top)
        setKey(sectionAt(entries, tops, line)?.key ?? null)
      },
      { root, rootMargin: READING_LINE },
    )
    for (const entry of entries) {
      const target = outlineTarget(root, entry)
      if (target) observer.observe(target)
    }
    return () => observer.disconnect()
  }, [panel, entries, open])
  return key
}

export function truncate(text: string, limit = 48): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single
}
