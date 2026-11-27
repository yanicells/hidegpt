import { lazy, Suspense, useSyncExternalStore } from 'react'

import { MIcon, type MaterialIconName } from '../ui/MaterialIcon'
import { Menu, MenuPopup, MenuTrigger } from '../ui/menu'
import { MenuRows, type Item } from '../ui/MenuPanel'
import { Tip } from '../ui/tooltip'
import type { ListKind } from './ToolMenuPanels'

/*
 * Docs' menus for the toolbar's align, line spacing and list tools. They are
 * costume (owner decision S5): picks move the checks and the align glyph but
 * change nothing in the document. Geometry is in tool-menus.css.
 */

/** The menus' insides load on first hover or focus of a tool (see ToolMenuPanels.tsx). */
const loadPanels = () => import('./ToolMenuPanels')
const preload = () => void loadPanels()
const AlignPalette = lazy(() => loadPanels().then((panels) => ({ default: panels.AlignPalette })))
const ListGrid = lazy(() => loadPanels().then((panels) => ({ default: panels.ListGrid })))

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

/** Picks an align by its palette value. */
function pickAlign(value: string) {
  const option = ALIGNS.find((item) => item.value === value)
  if (option) setParagraph({ align: option.value })
}

/** "Align & indent ▾": Docs' palette of four align buttons under the tool. */
export function AlignMenu() {
  const { align } = useParagraph()
  const current = ALIGNS.find((option) => option.value === align) ?? ALIGNS[0]
  return (
    <Menu modal={false} orientation="horizontal">
      <Tip label="Align & indent">
        <MenuTrigger
          className="toolbar-icon tb-menu with-caret fold-align"
          aria-label="Align & indent"
          data-testid="tool-align"
          onPointerEnter={preload}
          onFocus={preload}
        >
          <MIcon name={current.icon} />
          <MIcon name="arrow_drop_down" className="tb-caret" />
        </MenuTrigger>
      </Tip>
      <MenuPopup className="tool-menu align-menu" sideOffset={0}>
        <Suspense fallback={null}>
          <AlignPalette options={ALIGNS} value={align} onPick={pickAlign} />
        </Suspense>
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
        <MenuTrigger
          className="toolbar-icon tb-menu fold-spacing"
          aria-label="Line & paragraph spacing"
          data-testid="tool-spacing"
        >
          <MIcon name="format_line_spacing" />
        </MenuTrigger>
      </Tip>
      <MenuPopup className="tool-menu spacing-menu" sideOffset={0}>
        <MenuRows items={items} itemPrefix="spacing" />
      </MenuPopup>
    </Menu>
  )
}

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
          <MenuTrigger
            className="tb-caret"
            aria-label={tool.menu}
            data-testid={`tool-${kind}`}
            onPointerEnter={preload}
            onFocus={preload}
          >
            <MIcon name="arrow_drop_down" />
          </MenuTrigger>
        </Tip>
        <MenuPopup className={`tool-menu ${kind}-menu`} sideOffset={0} alignOffset={-30}>
          <Suspense fallback={null}>
            <ListGrid kind={kind} />
          </Suspense>
        </MenuPopup>
      </Menu>
    </span>
  )
}
