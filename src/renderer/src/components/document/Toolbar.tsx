import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { useCallback, useRef, useState } from 'react'

import type { Snapshot } from '../../../../shared/model'
import { dispatch } from '../../session-bridge'
import { renderClosingPositioner } from '../ui/closing-positioner'
import { PlaySparkIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'
import { MenuRows } from '../ui/MenuPanel'
import { Popover, PopoverTrigger } from '../ui/popover'
import { capitalize } from '../ui/text'
import { Tip } from '../ui/tooltip'
import { Chip } from './Chip'
import { ModeMenu, StyleMenu } from './PickerMenus'
import {
  effortFonts,
  FONT_SIZES,
  fontRows,
  fontStack,
  sizeForTier,
  sizeRowId,
  styleName,
  tierForSize,
  ZOOMS,
} from './toolbarMenus'
import { Decor, FoldingTools, type Mark, ToolButton } from './ToolbarTools'
import { fitZoom, usePageZoom } from './usePageZoom'

/**
 * Docs' formatting toolbar. Real settings hide inside its controls: the style
 * menu picks the model, the font menu the reasoning effort, the size box the
 * service tier, the pencil menu the mode. Everything else is costume.
 */
export function Toolbar({ snap }: { snap: Snapshot }) {
  const [zoom, setZoom] = usePageZoom()
  const modelIndex = snap.models.findIndex((item) => item.id === snap.model)
  const model = snap.models[modelIndex]
  const efforts = effortFonts(model?.efforts ?? [])
  const effort = snap.effort ?? model?.defaultEffort ?? null
  const currentFont = efforts.find((item) => item.effort === effort)?.font ?? 'Arial'
  const tiers = (model?.serviceTiers ?? []).map((tier) => tier.id)
  const size = sizeForTier(snap.serviceTier, tiers)
  const stepTier = (step: number) => {
    const order = [null, ...tiers]
    const next = order[Math.max(0, Math.min(order.length - 1, order.indexOf(snap.serviceTier ?? null) + step))]
    if (next !== (snap.serviceTier ?? null)) void dispatch({ op: 'setServiceTier', serviceTier: next })
  }
  // The ⋮ row portals into the wrap, the size container both rows query (toolbar.css).
  const wrap = useRef<HTMLDivElement>(null)
  const [marks, setMarks] = useState<ReadonlySet<Mark>>(() => new Set())
  const toggleMark = useCallback((mark: Mark) => {
    setMarks((current) => {
      const next = new Set(current)
      if (!next.delete(mark)) next.add(mark)
      return next
    })
  }, [])

  return (
    <div className="toolbar-wrap" ref={wrap}>
      <div className="toolbar" role="toolbar" aria-label="Document settings">
        <Decor name="search" label="Search the menus (⌥/)" className="tb-search" />
        {/* execCommand is deprecated but still the only way to drive the composer's native undo stack. */}
        <ToolButton name="undo" label="Undo (⌘Z)" onClick={() => document.execCommand('undo')} />
        <ToolButton name="redo" label="Redo (⌘Y)" onClick={() => document.execCommand('redo')} />
        <ToolButton name="print" label="Print (⌘P)" onClick={() => window.print()} />
        <Decor name="spellcheck" label="Spelling and grammar check (⌘⌥X)" className="fold-spell" />
        <Decor name="format_paint" label="Paint format" className="fold-paint" />
        <Chip testId="chip-zoom" label={`${zoom}%`} className="chip-zoom" menuClass="zoom-menu" tip="Zoom">
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
          tip="Styles"
        >
          <StyleMenu snap={snap} />
        </Chip>
        <span className="divider" aria-hidden="true" />
        <Chip testId="chip-effort" label={currentFont} className="chip-font" menuClass="font-menu" tip="Font">
          <MenuRows
            itemPrefix="pick"
            items={[
              { id: 'more-fonts', label: 'More fonts', icon: 'text_format' },
              ...fontRows(efforts).map(({ font, effort: rowEffort }, index) => ({
                id: rowEffort ?? `font-${font.toLowerCase().replace(/\W+/g, '-')}`,
                label: font,
                tip: rowEffort ? capitalize(rowEffort) : undefined,
                divider: index === 0,
                checked: rowEffort === undefined ? undefined : rowEffort === effort,
                style: { fontFamily: fontStack(font) },
                run: rowEffort ? () => dispatch({ op: 'setEffort', effort: rowEffort }) : undefined,
              })),
            ]}
          />
        </Chip>
        <span className="divider" aria-hidden="true" />
        <span className="font-size">
          <Tip label="Decrease font size (⌘⇧,)">
            <button
              type="button"
              className="font-size-step"
              aria-label="Decrease font size"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => stepTier(-1)}
            >
              <MIcon name="remove" />
            </button>
          </Tip>
          <Chip
            testId="chip-speed"
            label={String(size)}
            chevron={false}
            className="font-size-box"
            menuClass="size-menu"
            tip="Font size"
          >
            <MenuRows
              itemPrefix="pick"
              items={FONT_SIZES.map((value) => ({
                id: sizeRowId(value, tiers),
                label: String(value),
                checked: value === size,
                run: () => dispatch({ op: 'setServiceTier', serviceTier: tierForSize(value, tiers) }),
              }))}
            />
          </Chip>
          <Tip label="Increase font size (⌘⇧.)">
            <button
              type="button"
              className="font-size-step"
              aria-label="Increase font size"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => stepTier(1)}
            >
              <MIcon name="add" />
            </button>
          </Tip>
        </span>
        <span className="divider" aria-hidden="true" />
        <FoldingTools marks={marks} onToggle={toggleMark} />
        <Popover>
          <Tip label="More">
            <PopoverTrigger className="toolbar-icon toolbar-more" aria-label="More" data-testid="toolbar-more">
              <MIcon name="more_vert" />
            </PopoverTrigger>
          </Tip>
          <PopoverPrimitive.Portal container={wrap}>
            <PopoverPrimitive.Positioner
              align="end"
              className="menu-positioner"
              collisionPadding={8}
              render={renderClosingPositioner}
              sideOffset={8}
            >
              {/* Like Docs, opening the row leaves focus (and the caret) in the composer. */}
              <PopoverPrimitive.Popup className="popover-panel toolbar-overflow" initialFocus={false}>
                <FoldingTools overflow marks={marks} onToggle={toggleMark} />
              </PopoverPrimitive.Popup>
            </PopoverPrimitive.Positioner>
          </PopoverPrimitive.Portal>
        </Popover>
        <div className="toolbar-spacer" />
        <span className="toolbar-icon tb-spark" aria-hidden="true">
          <PlaySparkIcon />
        </span>
        <Chip
          testId="chip-mode"
          icon={<MIcon name="edit" />}
          className="chip-mode"
          menuClass="mode-menu"
          tip="Editing mode"
          align="end"
        >
          <ModeMenu snap={snap} />
        </Chip>
        <span className="divider" aria-hidden="true" />
        <Decor name="keyboard_arrow_up" label="Hide the menus (⌃⇧F)" />
      </div>
    </div>
  )
}
