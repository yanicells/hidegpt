import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { ChevronIcon, PenIcon } from '../ui/Icons'
import { MIcon, type MaterialIconName } from '../ui/MaterialIcon'
import { MenuPanel, type Item, type MenuId } from '../ui/MenuPanel'
import { openImagePicker } from './Composer'

export function Toolbar({ snap }: { snap: Snapshot }) {
  const [menu, setMenu] = useState<MenuId>(null)
  const model = snap.models.find((item) => item.model === snap.model)
  const efforts = model?.supportedReasoningEfforts ?? []
  const tiers = model?.serviceTiers ?? []
  const toggle = (id: MenuId) => setMenu(menu === id ? null : id)

  return (
    <div className="toolbar-wrap">
      <div className="toolbar" role="toolbar" aria-label="Document settings">
        <Decor name="search" className="tb-optional" />
        <ToolButton name="undo" label="Undo" onClick={() => document.execCommand('undo')} />
        <ToolButton name="redo" label="Redo" onClick={() => document.execCommand('redo')} />
        <ToolButton name="print" label="Print document" onClick={() => window.print()} />
        <Decor name="paint" className="tb-optional" />
        <span className="toolbar-static">
          100% <ChevronIcon />
        </span>
        <span className="divider" aria-hidden="true" />
        <Chip
          testId="chip-model"
          label="Normal text"
          open={menu === 'model'}
          onClick={() => toggle('model')}
          searchable
          searchPlaceholder="Search models"
          items={snap.models.map((item) => ({
            id: item.model,
            label: item.displayName,
            checked: item.model === snap.model,
            run: () => dispatch({ op: 'setModel', model: item.model }),
          }))}
          onClose={() => setMenu(null)}
        />
        {efforts.length > 0 ? (
          <>
            <span className="divider" aria-hidden="true" />
            <Chip
              testId="chip-effort"
              label="Arial"
              open={menu === 'effort'}
              onClick={() => toggle('effort')}
              items={efforts.map((item) => ({
                id: item.reasoningEffort,
                label: capitalize(item.reasoningEffort),
                checked: item.reasoningEffort === snap.effort,
                run: () => dispatch({ op: 'setEffort', effort: item.reasoningEffort }),
              }))}
              onClose={() => setMenu(null)}
            />
          </>
        ) : (
          <>
            <span className="divider" aria-hidden="true" />
            <span className="toolbar-static" aria-hidden="true">
              Arial <ChevronIcon />
            </span>
          </>
        )}
        <span className="divider" aria-hidden="true" />
        <span className="font-size">
          <span className="font-size-step" aria-hidden="true">
            −
          </span>
          {tiers.length > 0 ? (
            <Chip
              testId="chip-speed"
              label="11"
              chevron={false}
              className="font-size-box"
              open={menu === 'serviceTier'}
              onClick={() => toggle('serviceTier')}
              items={[
                {
                  id: 'default',
                  label: 'Standard',
                  checked: snap.serviceTier == null,
                  run: () => dispatch({ op: 'setServiceTier', serviceTier: null }),
                },
                ...tiers.map((tier) => ({
                  id: tier.id,
                  label: tier.name,
                  checked: tier.id === snap.serviceTier,
                  run: () => dispatch({ op: 'setServiceTier', serviceTier: tier.id }),
                })),
              ]}
              onClose={() => setMenu(null)}
            />
          ) : (
            <span className="font-size-box" aria-hidden="true">
              11
            </span>
          )}
          <span className="font-size-step" aria-hidden="true">
            +
          </span>
        </span>
        <span className="divider" aria-hidden="true" />
        <Decor name="bold" />
        <Decor name="italic" />
        <Decor name="underline" />
        <span className="toolbar-icon text-color" aria-hidden="true">
          <MIcon name="textColor" />
        </span>
        <Decor name="highlight" className="tb-optional" />
        <span className="divider tb-optional" aria-hidden="true" />
        <Decor name="link" className="tb-optional" />
        <Decor name="addComment" className="tb-optional" />
        <ToolButton name="image" label="Insert image" onClick={openImagePicker} />
        <span className="divider tb-wide" aria-hidden="true" />
        <Decor name="alignLeft" className="tb-wide" />
        <Decor name="lineSpacing" className="tb-wide" />
        <Decor name="checklist" className="tb-wide" />
        <Decor name="bullets" className="tb-wide" />
        <Decor name="numbered" className="tb-wide" />
        <Decor name="indentLess" className="tb-wide" />
        <Decor name="indentMore" className="tb-wide" />
        <Decor name="clearFormat" className="tb-wide" />
        <span className="divider" aria-hidden="true" />
        <Decor name="more" />
        <div className="toolbar-spacer" />
        <Chip
          testId="chip-provider"
          label="Editing"
          open={menu === 'provider'}
          align="end"
          onClick={() => toggle('provider')}
          items={[
            {
              id: 'codex',
              label: 'Codex',
              checked: snap.provider === 'codex',
              run: () => dispatch({ op: 'setProvider', provider: 'codex' }),
            },
            {
              id: 'opencode',
              label: 'OpenCode',
              checked: snap.provider === 'opencode',
              run: () => dispatch({ op: 'setProvider', provider: 'opencode' }),
            },
          ]}
          onClose={() => setMenu(null)}
        />
        {snap.collaborationModes.length > 1 ? (
          <>
            <span className="divider" aria-hidden="true" />
            <Chip
              testId="chip-mode"
              icon={<PenIcon />}
              label="Options"
              open={menu === 'mode'}
              align="end"
              onClick={() => toggle('mode')}
              items={snap.collaborationModes.map((item) => ({
                id: item.name,
                label: item.name,
                checked: item.name === snap.collaborationMode,
                run: () => dispatch({ op: 'setCollaborationMode', name: item.name }),
              }))}
              onClose={() => setMenu(null)}
            />
          </>
        ) : null}
        <Decor name="collapse" className="tb-optional" />
      </div>
    </div>
  )
}

/** A toolbar glyph that is part of the Docs costume only. */
function Decor({ name, className }: { name: MaterialIconName; className?: string }) {
  return (
    <span className={`toolbar-icon${className ? ` ${className}` : ''}`} aria-hidden="true">
      <MIcon name={name} />
    </span>
  )
}

function ToolButton({ name, label, onClick }: { name: MaterialIconName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="toolbar-icon"
      aria-label={label}
      title={label}
      // Keeps focus (and the undo stack target) in the composer.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <MIcon name={name} />
    </button>
  )
}

function Chip({
  label,
  icon,
  chevron = true,
  className,
  open,
  onClick,
  testId,
  items,
  align,
  searchable,
  searchPlaceholder,
  onClose,
}: {
  label: string
  icon?: ReactNode
  chevron?: boolean
  className?: string
  open: boolean
  onClick: () => void
  testId: string
  items: Item[]
  align?: 'start' | 'end'
  searchable?: boolean
  searchPlaceholder?: string
  onClose: () => void
}) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)

  useLayoutEffect(() => {
    if (open) setRect(anchorRef.current?.getBoundingClientRect() ?? null)
    else setRect(null)
  }, [open])

  return (
    <div className="menu">
      <button
        type="button"
        ref={anchorRef}
        className={`chip${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onClick}
      >
        {icon}
        <span className="chip-label">{label}</span>
        {chevron ? <ChevronIcon /> : null}
      </button>
      {open && rect
        ? createPortal(
            <ChipPopover
              anchor={rect}
              anchorEl={anchorRef.current}
              align={align}
              items={items}
              searchable={searchable}
              searchPlaceholder={searchPlaceholder}
              onClose={onClose}
            />,
            document.body,
          )
        : null}
    </div>
  )
}

function ChipPopover({
  anchor,
  anchorEl,
  align,
  items,
  searchable,
  searchPlaceholder,
  onClose,
}: {
  anchor: DOMRect
  anchorEl: HTMLElement | null
  align?: 'start' | 'end'
  items: Item[]
  searchable?: boolean
  searchPlaceholder?: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const visible =
    query.trim() === '' ? items : items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()))

  useEffect(() => {
    if (searchable) searchRef.current?.focus()
  }, [searchable])

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      // Clicks on the chip button toggle via onClick; dismissing here first
      // would let the click reopen the menu instead of closing it.
      if (anchorEl?.contains(target)) return
      if (ref.current && !ref.current.contains(target)) onClose()
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        anchorEl?.focus()
      }
    }
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return
      onClose()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  const width = Math.min(360, Math.max(240, anchor.width + 48))
  const maxHeight = Math.min(340, window.innerHeight - 16)
  const opensUp = anchor.bottom + 8 + 200 > window.innerHeight && anchor.top - 8 - maxHeight > 0
  const style: CSSProperties = opensUp
    ? {
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        bottom: window.innerHeight - anchor.top + 8,
        width,
        maxHeight,
      }
    : {
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        top: anchor.bottom + 8,
        width,
        maxHeight,
      }
  if (align === 'end') {
    style.left = Math.max(8, anchor.right - width)
  }

  return (
    <div ref={ref} className="popover" style={style}>
      {searchable ? (
        <div className="popover-search">
          <input
            ref={searchRef}
            data-testid="menu-search"
            type="search"
            aria-label={searchPlaceholder ?? 'Search'}
            placeholder={searchPlaceholder ?? 'Search'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      ) : null}
      {visible.length > 0 ? (
        <MenuPanel items={visible} onClose={onClose} itemPrefix="pick" />
      ) : (
        <div className="popover-empty">No matches</div>
      )}
    </div>
  )
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}
