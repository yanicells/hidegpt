/*
 * The align palette's radio items are adapted from T3 Code (apps/web/src/components/ui/menu.tsx).
 * Copyright (c) 2026 T3 Tools Inc. Licensed under the MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { useSyncExternalStore, type CSSProperties } from 'react'

import { MIcon, type MaterialIconName } from '../ui/MaterialIcon'
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from '../ui/menu'
import { MenuRows, type Item } from '../ui/MenuPanel'
import { Tip } from '../ui/tooltip'

/*
 * Docs' menus for the toolbar's align, line spacing and list tools. They are
 * costume (owner decision S5): picks move the checks and the align glyph but
 * change nothing in the document. Geometry is in tool-menus.css.
 */

type Align = 'left' | 'center' | 'right' | 'justify'
type Spacing = 'single' | '1.15' | '1.5' | 'double'
type Flow = 'keep-with-next' | 'keep-lines' | 'widow' | 'page-break'

/** The paragraph settings the menus show: Docs' defaults for a new document. */
type Paragraph = { align: Align; spacing: Spacing; flow: ReadonlySet<Flow> }

/*
 * The pill and the ⋮ row each draw these tools, and the same tool must show the
 * same pick in both, so the settings live here rather than in either copy.
 */
let paragraph: Paragraph = { align: 'left', spacing: '1.15', flow: new Set(['widow']) }
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function setParagraph(change: Partial<Paragraph>) {
  paragraph = { ...paragraph, ...change }
  for (const listener of listeners) listener()
}

function useParagraph(): Paragraph {
  return useSyncExternalStore(subscribe, () => paragraph)
}

const ALIGNS: ReadonlyArray<{ value: Align; icon: MaterialIconName; name: string; keys: string }> = [
  { value: 'left', icon: 'format_align_left', name: 'Left align', keys: '⌘⇧L' },
  { value: 'center', icon: 'format_align_center', name: 'Center align', keys: '⌘⇧E' },
  { value: 'right', icon: 'format_align_right', name: 'Right align', keys: '⌘⇧R' },
  { value: 'justify', icon: 'format_align_justify', name: 'Justify', keys: '⌘⇧J' },
]

/** "Align & indent ▾": Docs' palette of four align buttons under the tool. */
export function AlignMenu() {
  const { align } = useParagraph()
  const current = ALIGNS.find((option) => option.value === align) ?? ALIGNS[0]
  return (
    <Menu modal={false} orientation="horizontal">
      <Tip label="Align & indent">
        <MenuTrigger className="toolbar-icon tb-menu with-caret fold-align" aria-label="Align & indent">
          <MIcon name={current.icon} />
          <MIcon name="arrow_drop_down" className="tb-caret" />
        </MenuTrigger>
      </Tip>
      <MenuPopup className="tool-menu align-menu" sideOffset={0}>
        <MenuPrimitive.RadioGroup
          className="align-palette"
          value={align}
          onValueChange={(value: Align) => setParagraph({ align: value })}
        >
          {ALIGNS.map((option) => (
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
      </MenuPopup>
    </Menu>
  )
}

const SPACINGS: ReadonlyArray<readonly [Spacing, string]> = [
  ['single', 'Single'],
  ['1.15', '1.15'],
  ['1.5', '1.5'],
  ['double', 'Double'],
]

const FLOWS: ReadonlyArray<readonly [Flow, string]> = [
  ['keep-with-next', 'Keep with next'],
  ['keep-lines', 'Keep lines together'],
  ['widow', 'Prevent single lines'],
  ['page-break', 'Add page break before'],
]

/** "Line & paragraph spacing": Docs' rows; the spacing and pagination rows check, the rest do nothing. */
export function SpacingMenu() {
  const { spacing, flow } = useParagraph()
  const toggle = (id: Flow) => {
    const next = new Set(flow)
    if (!next.delete(id)) next.add(id)
    setParagraph({ flow: next })
  }
  const items: Item[] = [
    ...SPACINGS.map(([id, label]) => ({
      id,
      label,
      checked: id === spacing,
      run: () => setParagraph({ spacing: id }),
    })),
    { id: 'space-before', label: 'Add space before paragraph', divider: true },
    { id: 'space-after', label: 'Add space after paragraph' },
    { id: 'custom', label: 'Custom spacing', divider: true },
    ...FLOWS.map(([id, label], index) => ({
      id,
      label,
      divider: index === 0,
      checked: flow.has(id),
      run: () => toggle(id),
    })),
  ]
  return (
    <Menu modal={false}>
      <Tip label="Line & paragraph spacing">
        <MenuTrigger className="toolbar-icon tb-menu fold-spacing" aria-label="Line & paragraph spacing">
          <MIcon name="format_line_spacing" />
        </MenuTrigger>
      </Tip>
      <MenuPopup className="tool-menu spacing-menu" sideOffset={0}>
        <MenuRows items={items} itemPrefix="spacing" />
      </MenuPopup>
    </Menu>
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

type Preset = { name: string; marks: readonly [string, string, string, string, string] }

const BULLETS: readonly Preset[] = [
  { name: 'Disc, circle, square', marks: ['●', '○', '○', '■', '●'] },
  { name: 'Diamond, arrowhead, square', marks: ['❖', '➢', '➢', '■', '❖'] },
  { name: 'Box', marks: ['❑', '❑', '❑', '❑', '❑'] },
  { name: 'Arrow, diamond, disc', marks: ['➔', '◆', '◆', '●', '➔'] },
  { name: 'Star, circle, square', marks: ['★', '○', '○', '■', '★'] },
  { name: 'Arrowhead, circle, square', marks: ['➢', '○', '○', '■', '➢'] },
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

type ListKind = 'checklist' | 'bullets' | 'numbered'

const LIST_TOOLS: Record<ListKind, { icon: MaterialIconName; name: string; keys: string; menu: string }> = {
  checklist: { icon: 'checklist', name: 'Checklist', keys: '⌘⇧9', menu: 'Checklist menu' },
  bullets: { icon: 'format_list_bulleted', name: 'Bulleted list', keys: '⌘⇧8', menu: 'Bulleted list menu' },
  numbered: { icon: 'format_list_numbered', name: 'Numbered list', keys: '⌘⇧7', menu: 'Numbered list menu' },
}

/**
 * A list tool: Docs' split button, the glyph on the left (costume) and a
 * caret on the right opening the preset grid. The grid hangs from the
 * tool's left edge, 30px left of the caret.
 */
export function ListTool({ kind }: { kind: ListKind }) {
  const tool = LIST_TOOLS[kind]
  return (
    <span className={`toolbar-icon tb-split with-caret fold-${kind}`}>
      <Tip label={`${tool.name} (${tool.keys})`}>
        <MIcon name={tool.icon} className="tb-split-icon" />
      </Tip>
      <Menu modal={false}>
        <Tip label={tool.menu}>
          <MenuTrigger className="tb-caret" aria-label={tool.menu} data-testid={`${kind}-menu`}>
            <MIcon name="arrow_drop_down" />
          </MenuTrigger>
        </Tip>
        <MenuPopup className={`tool-menu ${kind}-menu`} sideOffset={0} alignOffset={-30}>
          {kind === 'checklist' ? (
            <ChecklistGrid />
          ) : (
            <PresetGrid presets={kind === 'bullets' ? BULLETS : NUMBERS} prefix={kind} />
          )}
          {kind === 'bullets' ? <ChecklistCascade /> : null}
        </MenuPopup>
      </Menu>
    </span>
  )
}

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
