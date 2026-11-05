import { Fragment, type ReactNode } from 'react'

import { cn } from '../ui/cn'
import { MIcon, type MaterialIconName } from '../ui/MaterialIcon'
import { Tip } from '../ui/tooltip'
import { openImagePicker } from './Composer'

/**
 * Tool groups Docs folds behind ⋮ as the window narrows, each tagged with the
 * class whose breakpoint hides it (toolbar.css). The toolbar draws them after
 * the size box; the ⋮ row draws the same groups but shows only the folded
 * ones, plus the indent and clear-formatting tools Docs always keeps there.
 */
const FOLDING_GROUPS: { fold: string; tools: ReactNode }[] = [
  {
    fold: 'tb-md',
    tools: (
      <>
        <Decor name="format_bold" label="Bold (⌘B)" className="tb-md" />
        <Decor name="format_italic" label="Italic (⌘I)" className="tb-md" />
        <Decor name="format_underlined" label="Underline (⌘U)" className="tb-md" />
        <Decor name="format_color_text" label="Text color" className="tb-md text-color" />
        <Decor name="ink_highlighter" label="Highlight color" className="tb-md highlight-color" />
      </>
    ),
  },
  {
    fold: 'tb-lg',
    tools: (
      <>
        <Decor name="link" label="Insert link (⌘K)" className="tb-lg" />
        <Decor name="add_comment" label="Add comment (⌘⌥M)" className="tb-lg" />
        <ToolButton name="image" label="Insert image" onClick={openImagePicker} className="tb-lg" />
      </>
    ),
  },
  {
    fold: 'tb-wide',
    tools: (
      <>
        <Decor name="format_align_left" label="Align & indent" caret className="tb-wide" />
        <Decor name="format_line_spacing" label="Line & paragraph spacing" className="tb-wide" />
        <Decor name="checklist" label="Checklist (⌘⇧9)" caret className="tb-wide" />
        {/* The list buttons fold a step before the rest of their group. */}
        <Decor name="format_list_bulleted" label="Bulleted list (⌘⇧8)" caret className="tb-xl" />
        <Decor name="format_list_numbered" label="Numbered list (⌘⇧7)" caret className="tb-xl" />
      </>
    ),
  },
]

/** The ⋮ row's extra groups: spellcheck/paint fold from before the zoom chip; indents never fit. */
const OVERFLOW_ONLY = {
  before: (
    <>
      <Decor name="spellcheck" label="Spelling and grammar check (⌘⌥X)" className="tb-sm" />
      <Decor name="format_paint" label="Paint format" className="tb-sm" />
      <span className="divider tb-sm" aria-hidden="true" />
    </>
  ),
  after: (
    <>
      <Decor name="format_indent_decrease" label="Decrease indent (⌘[)" />
      <Decor name="format_indent_increase" label="Increase indent (⌘])" />
      <Decor name="format_clear" label="Clear formatting (⌘\\)" />
    </>
  ),
}

/**
 * The folding groups. In the toolbar a divider leads each group and stays
 * while any of it shows; in the ⋮ row it trails, showing once any of it folds.
 */
export function FoldingTools({ overflow = false }: { overflow?: boolean }) {
  const groups = FOLDING_GROUPS.map(({ fold, tools }) => (
    <Fragment key={fold}>
      {overflow ? null : <span className={cn('divider', fold)} aria-hidden="true" />}
      {tools}
      {overflow ? <span className={cn('divider', fold === 'tb-wide' ? 'tb-xl' : fold)} aria-hidden="true" /> : null}
    </Fragment>
  ))
  if (!overflow) return groups
  return (
    <>
      {OVERFLOW_ONLY.before}
      {groups}
      {OVERFLOW_ONLY.after}
    </>
  )
}

/** A toolbar glyph that is part of the Docs costume only. */
export function Decor({
  name,
  label,
  className,
  caret,
}: {
  name: MaterialIconName
  /** Docs' tooltip for the tool. */
  label: string
  className?: string
  caret?: boolean
}) {
  return (
    <Tip label={label}>
      <span className={cn('toolbar-icon', caret && 'with-caret', className)} aria-hidden="true">
        <MIcon name={name} />
        {caret ? <MIcon name="arrow_drop_down" size={16} className="tb-caret" /> : null}
      </span>
    </Tip>
  )
}

export function ToolButton({
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
    <Tip label={label}>
      <button
        type="button"
        className={cn('toolbar-icon', className)}
        aria-label={label.replace(/ \(.*\)$/, '')}
        // Keeps focus (and the undo stack target) in the composer.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
      >
        <MIcon name={name} />
      </button>
    </Tip>
  )
}
