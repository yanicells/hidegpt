/*
 * The align palette's radio items are adapted from T3 Code (apps/web/src/components/ui/menu.tsx).
 * Copyright (c) 2026 T3 Tools Inc. Licensed under the MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import type { CSSProperties, ReactNode } from 'react'

import { MIcon, type MaterialIconName } from '../ui/MaterialIcon'
import { MenuItem, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger } from '../ui/menu'
import { Tip } from '../ui/tooltip'

/*
 * The insides of the toolbar's tool menus (ToolMenus.tsx), loaded on first
 * use so the preview art and Base UI's radio items stay out of the entry chunk.
 */

export type PaletteOption = { value: string; icon: MaterialIconName; name: string; keys: string }

/** Docs' align palette: one pressed button among four, with Docs' tooltips. */
export function AlignPalette({
  options,
  value,
  onPick,
}: {
  options: readonly PaletteOption[]
  value: string
  onPick: (value: string) => void
}) {
  return (
    <MenuPrimitive.RadioGroup className="align-palette" value={value} onValueChange={(next: string) => onPick(next)}>
      {options.map((option) => (
        <Tip key={option.value} label={`${option.name} (${option.keys})`}>
          <MenuPrimitive.RadioItem
            className="align-option"
            value={option.value}
            closeOnClick
            aria-label={option.name}
            data-testid={`align-${option.value}`}
          >
            <MIcon name={option.icon} />
          </MenuPrimitive.RadioItem>
        </Tip>
      ))}
    </MenuPrimitive.RadioGroup>
  )
}

export type ListKind = 'checklist' | 'bullets' | 'numbered'

/** A list tool's grid: the checklist pair, or six presets (bullets also cascade to the checklist pair). */
export function ListGrid({ kind }: { kind: ListKind }) {
  if (kind === 'checklist') return <ChecklistGrid />
  return (
    <>
      <PresetGrid presets={kind === 'bullets' ? BULLETS : NUMBERS} prefix={kind} />
      {kind === 'bullets' ? <ChecklistCascade /> : null}
    </>
  )
}

/** Each preview has five rows at these list levels; only the marks change. */
const PRESET_ROWS = [
  { id: 'first', level: 0 },
  { id: 'sub-1', level: 1 },
  { id: 'sub-2', level: 1 },
  { id: 'sub-sub', level: 2 },
  { id: 'second', level: 0 },
] as const

type Preset = { name: string; marks: readonly [ReactNode, ReactNode, ReactNode, ReactNode, ReactNode] }

/** A bullet drawn at the size Docs' previews show it (font glyphs fall back to faces of other sizes). */
function Bullet({ w, h, d }: { w: number; h: number; d: string }) {
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="currentColor" fillRule="evenodd" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const DISC = <Bullet w={7} h={7} d="M3.5 0a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7Z" />
const CIRCLE = (
  <Bullet w={7} h={7} d="M3.5 0a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7Zm0 .6a2.9 2.9 0 1 1 0 5.8a2.9 2.9 0 1 1 0-5.8Z" />
)
const SQUARE = <Bullet w={6} h={6} d="M0 0h6v6H0Z" />
const DIAMOND = <Bullet w={7} h={8} d="M3.5 0 7 4 3.5 8 0 4Z" />
const FOUR_DIAMONDS = (
  <Bullet
    w={8}
    h={8}
    d="M4 0l1.75 1.75L4 3.5 2.25 1.75Zm0 4.5 1.75 1.75L4 8 2.25 6.25ZM1.75 2.25 3.5 4 1.75 5.75 0 4Zm4.5 0L8 4 6.25 5.75 4.5 4Z"
  />
)
const ARROWHEAD = <Bullet w={10} h={6} d="M0 0 10 3 0 6 2.5 3Z" />
const ARROW = <Bullet w={9} h={6} d="M0 2.25h5.5V0L9 3 5.5 6V3.75H0Z" />
const STAR = <Bullet w={8} h={8} d="M4 .1 5 2.92 8 3 5.62 4.83 6.47 7.7 4 6 1.53 7.7 2.38 4.83 0 3 3 2.92Z" />
const SHADOW_BOX = <Bullet w={7} h={7} d="M0 0h6v6H0Zm1 1v4h4V1Zm5 1h1v5H2V6h4Z" />

const BULLETS: readonly Preset[] = [
  { name: 'Disc, circle, square', marks: [DISC, CIRCLE, CIRCLE, SQUARE, DISC] },
  { name: 'Diamonds, arrowhead, square', marks: [FOUR_DIAMONDS, ARROWHEAD, ARROWHEAD, SQUARE, FOUR_DIAMONDS] },
  { name: 'Box', marks: [SHADOW_BOX, SHADOW_BOX, SHADOW_BOX, SHADOW_BOX, SHADOW_BOX] },
  { name: 'Arrow, diamond, disc', marks: [ARROW, DIAMOND, DIAMOND, DISC, ARROW] },
  { name: 'Star, circle, square', marks: [STAR, CIRCLE, CIRCLE, SQUARE, STAR] },
  { name: 'Arrowhead, circle, square', marks: [ARROWHEAD, CIRCLE, CIRCLE, SQUARE, ARROWHEAD] },
]

const NUMBERS: readonly Preset[] = [
  { name: '1, a, i', marks: ['1.', 'a.', 'b.', 'i.', '2.'] },
  { name: '1), a), i)', marks: ['1)', 'a)', 'b)', 'i)', '2)'] },
  { name: '1, 1.1, 1.2.1', marks: ['1.', '1.1.', '1.2.', '1.2.1.', '2.'] },
  { name: 'A, a, i', marks: ['A.', 'a.', 'b.', 'i.', 'B.'] },
  { name: 'I, A, 1', marks: ['I.', 'A.', 'B.', '1.', 'II.'] },
  { name: '01, a, i', marks: ['01.', 'a.', 'b.', 'i.', '02.'] },
]

const CHECKLISTS = [
  { name: 'Checklist, cross out checked items', strike: true },
  { name: 'Checklist', strike: false },
] as const

/** Six list previews; each cell is a menu item that closes the menu and changes nothing. */
function PresetGrid({ presets, prefix }: { presets: readonly Preset[]; prefix: string }) {
  return (
    <div className="preset-grid">
      {presets.map((preset, index) => (
        <MenuItem key={preset.name} className="preset" aria-label={preset.name} data-testid={`${prefix}-${index}`}>
          {PRESET_ROWS.map((row, index) => (
            <span key={row.id} className="preset-row" style={{ '--row': index, '--level': row.level } as CSSProperties}>
              <span className="preset-mark">{preset.marks[index]}</span>
              <span className="preset-bar" />
            </span>
          ))}
        </MenuItem>
      ))}
    </div>
  )
}

/** The two checklist previews: one crosses out checked items, the other doesn't. */
function ChecklistGrid() {
  return (
    <div className="preset-grid">
      {CHECKLISTS.map((preset, index) => (
        <MenuItem
          key={preset.name}
          className={preset.strike ? 'preset check-preset strike' : 'preset check-preset'}
          aria-label={preset.name}
          data-testid={`checklist-${index}`}
        >
          <span className="check-row">
            <span className="check-box" />
            <span className="preset-bar" />
          </span>
          <span className="check-row">
            <span className="check-box">
              <MIcon name="check" size={10} />
            </span>
            <span className="preset-bar" />
          </span>
        </MenuItem>
      ))}
    </div>
  )
}

/** The bulleted list menu's last row cascades to the checklist grid. */
function ChecklistCascade() {
  return (
    <>
      <MenuSeparator />
      <MenuSub>
        <MenuSubTrigger data-testid="bullets-checklist">
          <span className="menu-icon" aria-hidden="true">
            <MIcon name="checklist" />
          </span>
          <span className="menu-text">Checklist menu</span>
        </MenuSubTrigger>
        <MenuSubPopup className="tool-menu checklist-menu">
          <ChecklistGrid />
        </MenuSubPopup>
      </MenuSub>
    </>
  )
}
