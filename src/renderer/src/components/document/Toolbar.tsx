import { useEffect, useState } from 'react'

import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { MIcon, type MaterialIconName } from '../ui/MaterialIcon'
import { MenuSearchInput } from '../ui/menu'
import { MenuRows, type Item } from '../ui/MenuPanel'
import { Chip } from './Chip'
import { openImagePicker } from './Composer'
import {
  EDIT_MODES,
  effortFonts,
  FONT_SIZES,
  sizeForTier,
  STYLE_SLOTS,
  styleName,
  tierForSize,
  ZOOMS,
} from './toolbarMenus'

/**
 * Docs' formatting toolbar. Real settings hide inside its controls: the style
 * menu picks the model, the font menu the reasoning effort, the size box the
 * service tier, the pencil menu the mode. Everything else is costume.
 */
export function Toolbar({ snap }: { snap: Snapshot }) {
  const [zoom, setZoom] = usePageZoom()
  const modelIndex = snap.models.findIndex((item) => item.model === snap.model)
  const model = snap.models[modelIndex]
  const efforts = effortFonts((model?.supportedReasoningEfforts ?? []).map((item) => item.reasoningEffort))
  const currentFont = efforts.find((item) => item.effort === snap.effort)?.font ?? 'Arial'
  const tiers = (model?.serviceTiers ?? []).map((tier) => tier.id)
  const size = sizeForTier(snap.serviceTier, tiers)
  const stepTier = (step: number) => {
    const order = [null, ...tiers]
    const next = order[Math.max(0, Math.min(order.length - 1, order.indexOf(snap.serviceTier ?? null) + step))]
    if (next !== (snap.serviceTier ?? null)) dispatch({ op: 'setServiceTier', serviceTier: next })
  }

  return (
    <div className="toolbar-wrap">
      <div className="toolbar" role="toolbar" aria-label="Document settings">
        <Decor name="search" />
        <ToolButton name="undo" label="Undo (⌘Z)" onClick={() => document.execCommand('undo')} />
        <ToolButton name="redo" label="Redo (⌘Y)" onClick={() => document.execCommand('redo')} />
        <ToolButton name="print" label="Print (⌘P)" onClick={() => window.print()} />
        <Decor name="spellcheck" className="tb-sm" />
        <Decor name="format_paint" className="tb-sm" />
        <Chip
          testId="chip-zoom"
          label={`${zoom}%`}
          className="chip-zoom"
          menuClass="zoom-menu"
          menuWidth={96}
          title="Zoom"
          >
            <MenuRows
              itemPrefix="zoom"
              items={[
                { id: 'fit', label: 'Fit', run: () => setZoom(fitZoom()) },
                ...ZOOMS.map((value, index) => ({
                  id: String(value),
                  label: `${value}%`,
                  divider: index === 0,
                  checked: value === zoom,
                  run: () => setZoom(value),
                })),
              ]}
            />
        </Chip>
        <span className="divider" aria-hidden="true" />
        <Chip
          testId="chip-model"
          label={modelIndex >= 0 ? styleName(modelIndex) : 'Normal text'}
          className="chip-style"
          menuClass="style-menu"
          menuWidth={222}
          title="Styles"
          >
          <StyleMenu snap={snap} />
        </Chip>
        <span className="divider" aria-hidden="true" />
        <Chip
          testId="chip-effort"
          label={currentFont}
          className="chip-font"
          menuClass="font-menu"
          menuWidth={222}
          title="Font"
          >
            <MenuRows
              itemPrefix="pick"
              items={[
                { id: 'more-fonts', label: 'More fonts', icon: 'text_format' },
                ...efforts.map((item, index) => ({
                  id: item.effort,
                  label: item.font,
                  title: capitalize(item.effort),
                  divider: index === 0,
                  checked: item.effort === snap.effort,
                  style: { fontFamily: item.font },
                  run: () => dispatch({ op: 'setEffort', effort: item.effort }),
                })),
              ]}
            />
        </Chip>
        <span className="divider" aria-hidden="true" />
        <span className="font-size">
          <button
            type="button"
            className="font-size-step"
            aria-label="Decrease font size"
            title="Decrease font size (⌘⇧,)"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => stepTier(-1)}
          >
            <MIcon name="remove" />
          </button>
          <Chip
            testId="chip-speed"
            label={String(size)}
            chevron={false}
            className="font-size-box"
            menuClass="size-menu"
            menuWidth={60}
            title="Font size"
            >
              <MenuRows
                itemPrefix="pick"
                  items={FONT_SIZES.map((value) => {
                  const tier = tierForSize(value, tiers)
                  return {
                    id: value === 11 ? 'default' : value === sizeForTier(tier, tiers) && tier ? tier : `size-${value}`,
                    label: String(value),
                    checked: value === size,
                    run: () => dispatch({ op: 'setServiceTier', serviceTier: tier }),
                  }
                })}
              />
          </Chip>
          <button
            type="button"
            className="font-size-step"
            aria-label="Increase font size"
            title="Increase font size (⌘⇧.)"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => stepTier(1)}
          >
            <MIcon name="add" />
          </button>
        </span>
        <span className="divider tb-md" aria-hidden="true" />
        <Decor name="format_bold" className="tb-md" />
        <Decor name="format_italic" className="tb-md" />
        <Decor name="format_underlined" className="tb-md" />
        <Decor name="format_color_text" className="tb-md text-color" />
        <Decor name="ink_highlighter" className="tb-md highlight-color" />
        <span className="divider tb-lg" aria-hidden="true" />
        <Decor name="link" className="tb-lg" />
        <Decor name="add_comment" className="tb-lg" />
        <ToolButton name="image" label="Insert image" onClick={openImagePicker} className="tb-lg" />
        <span className="divider tb-wide" aria-hidden="true" />
        <Decor name="format_align_left" caret className="tb-wide" />
        <Decor name="format_line_spacing" className="tb-wide" />
        <Decor name="checklist" caret className="tb-wide" />
        <Decor name="format_list_bulleted" caret className="tb-xl" />
        <Decor name="format_list_numbered" caret className="tb-xl" />
        <span className="divider" aria-hidden="true" />
        <Decor name="more_vert" />
        <div className="toolbar-spacer" />
        <Chip
          testId="chip-mode"
          icon={<MIcon name="edit" />}
          className="chip-mode"
          menuClass="mode-menu"
          menuWidth={290}
          title="Editing mode"
          align="end"
          >
          <ModeMenu snap={snap} />
        </Chip>
        <span className="divider" aria-hidden="true" />
        <Decor name="keyboard_arrow_up" />
      </div>
    </div>
  )
}

/** "Normal text ▾": each paragraph style is a model slot; Options lists every model. */
function StyleMenu({ snap }: { snap: Snapshot }) {
  const [all, setAll] = useState(false)
  const [query, setQuery] = useState('')
  if (all) {
    const needle = query.trim().toLowerCase()
    const items: Item[] = snap.models
      .filter((item) => !needle || `${item.displayName} ${item.model}`.toLowerCase().includes(needle))
      .map((item) => ({
        id: item.model,
        label: item.displayName,
        checked: item.model === snap.model,
        run: () => dispatch({ op: 'setModel', model: item.model }),
      }))
    return (
      <div className="all-styles">
        <MenuSearchInput
          autoFocus
          data-testid="menu-search"
          aria-label="Search styles"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {items.length ? (
          <MenuRows items={items} itemPrefix="pick" />
        ) : (
          <div className="popover-empty">No matches</div>
        )}
      </div>
    )
  }
  // Each Docs style is a model slot; slots beyond the provider's list stay plain styles.
  const items: Item[] = [
    ...STYLE_SLOTS.map((slot, index) => {
      const item = snap.models[index]
      return {
        id: item?.model ?? `style-${index}`,
        label: slot.name,
        className: slot.className,
        title: item?.displayName,
        arrow: true,
        checked: item ? item.model === snap.model : undefined,
        run: item ? () => dispatch({ op: 'setModel', model: item.model }) : undefined,
      }
    }),
    { id: 'options', label: 'Options', className: 'style-options', arrow: true, keepOpen: true, run: () => setAll(true) },
  ]
  return <MenuRows items={items} itemPrefix="pick" />
}

/** The pencil menu: Docs' Editing / Suggesting / Viewing, standing in for modes. */
function ModeMenu({ snap }: { snap: Snapshot }) {
  const modes = snap.collaborationModes
  const items: Item[] =
    modes.length > 1
      ? modes.map((mode, index) => ({
          id: mode.name,
          label: EDIT_MODES[index]?.label ?? mode.name,
          icon: EDIT_MODES[index]?.icon ?? 'edit_note',
          description: EDIT_MODES[index]?.description,
          title: mode.name,
          checked: mode.name === snap.collaborationMode,
          run: () => dispatch({ op: 'setCollaborationMode', name: mode.name }),
        }))
      : EDIT_MODES.map((mode, index) => ({
          id: mode.label.toLowerCase(),
          label: mode.label,
          icon: mode.icon,
          description: mode.description,
          checked: index === 0,
        }))
  return <MenuRows items={items} itemPrefix="pick" />
}

/** A toolbar glyph that is part of the Docs costume only. */
function Decor({ name, className, caret }: { name: MaterialIconName; className?: string; caret?: boolean }) {
  return (
    <span className={`toolbar-icon${caret ? ' with-caret' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      <MIcon name={name} />
      {caret ? <MIcon name="arrow_drop_down" size={16} className="caret" /> : null}
    </span>
  )
}

function ToolButton({
  name,
  label,
  onClick,
  className,
}: {
  name: MaterialIconName
  label: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      className={`toolbar-icon${className ? ` ${className}` : ''}`}
      aria-label={label.replace(/ \(.*\)$/, '')}
      title={label}
      // Keeps focus (and the undo stack target) in the composer.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <MIcon name={name} />
    </button>
  )
}

/** Page zoom shared with the document canvas through a CSS variable; persists. */
function usePageZoom(): [number, (value: number) => void] {
  const [zoom, setZoom] = useState(() => {
    try {
      return Number(localStorage.getItem('hidegpt.zoom')) || 100
    } catch {
      return 100
    }
  })
  useEffect(() => {
    document.documentElement.style.setProperty('--page-zoom', String(zoom / 100))
    try {
      localStorage.setItem('hidegpt.zoom', String(zoom))
    } catch {
      // Private storage: zoom just resets next launch.
    }
  }, [zoom])
  return [zoom, setZoom]
}

/** "Fit": the largest zoom (≤100%) that shows the whole page width. */
function fitZoom(): number {
  const area = document.querySelector<HTMLElement>('.paper-col')
  if (!area) return 100
  return Math.max(50, Math.min(100, Math.floor(((area.clientWidth - 32) / 816) * 100)))
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}
