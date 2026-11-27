import { memo } from 'react'

import { cn } from '../ui/cn'
import { MIcon, type MaterialIconName } from '../ui/MaterialIcon'
import { Tip } from '../ui/tooltip'
import { openImagePicker } from './Composer'

/** Text formatting Docs shows as pressed toggles. The state is visual only. */
export type Mark = 'bold' | 'italic' | 'underline'

type MarkProps = { marks: ReadonlySet<Mark>; onToggle: (mark: Mark) => void }

/**
 * The tools Docs folds behind ⋮, one at a time from the right, as the toolbar
 * narrows. The pill and the ⋮ row draw the same list; each `fold-*` class has
 * one container query in toolbar.css that hides the tool in the pill and shows
 * it in the ⋮ row. A divider carries its group's last tool's class, so it
 * shows before ⋮ only when that group ends the visible tools.
 *
 * `tb-md` and `tb-lg` name the first two groups; the fidelity targets select
 * tools by them.
 */
export const FoldingTools = memo(function FoldingTools({
  overflow = false,
  marks,
  onToggle,
}: MarkProps & { overflow?: boolean }) {
  return (
    <>
      {/* Docs folds spelling and paint format last, from before the zoom chip, so the pill draws them there. */}
      {overflow ? (
        <>
          <Decor name="spellcheck" label="Spelling and grammar check (⌘⌥X)" className="fold-spell" />
          <Decor name="format_paint" label="Paint format" className="fold-paint" />
          <span className="divider fold-paint" aria-hidden="true" />
        </>
      ) : null}
      <MarkToggle mark="bold" name="format_bold" label="Bold (⌘B)" marks={marks} onToggle={onToggle} />
      <MarkToggle mark="italic" name="format_italic" label="Italic (⌘I)" marks={marks} onToggle={onToggle} />
      <MarkToggle mark="underline" name="format_underlined" label="Underline (⌘U)" marks={marks} onToggle={onToggle} />
      <Decor name="format_color_text" label="Text color" className="tb-md tb-menu text-color fold-text-color" />
      <Decor name="ink_highlighter" label="Highlight color" className="tb-md tb-menu highlight-color fold-highlight" />
      <span className="divider fold-highlight" aria-hidden="true" />
      <Decor name="link" label="Insert link (⌘K)" className="tb-lg fold-link" />
      <Decor name="add_comment" label="Add comment (⌘⌥M)" className="tb-lg fold-comment" />
      <ToolButton name="image" label="Insert image" onClick={openImagePicker} className="tb-lg tb-menu fold-image" />
      <span className="divider fold-image" aria-hidden="true" />
      <Decor name="format_align_left" label="Align & indent" caret className="tb-menu fold-align" />
      <Decor name="format_line_spacing" label="Line & paragraph spacing" className="tb-menu fold-spacing" />
      <Decor name="checklist" label="Checklist (⌘⇧9)" caret className="tb-split fold-checklist" />
      <Decor name="format_list_bulleted" label="Bulleted list (⌘⇧8)" caret className="tb-split fold-bullets" />
      <Decor name="format_list_numbered" label="Numbered list (⌘⇧7)" caret className="tb-split fold-numbered" />
      <Decor name="format_indent_decrease" label="Decrease indent (⌘[)" className="fold-outdent" />
      <Decor name="format_indent_increase" label="Increase indent (⌘])" className="fold-indent" />
      <Decor name="format_clear" label="Clear formatting (⌘\\)" className="fold-clear" />
    </>
  )
})

/** Bold, italic or underline: a pressed-state toggle, like Docs' (visual only). */
function MarkToggle({
  mark,
  name,
  label,
  marks,
  onToggle,
}: MarkProps & { mark: Mark; name: MaterialIconName; label: string }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        className={`toolbar-icon tb-md fold-${mark}`}
        aria-label={label.replace(/ \(.*\)$/, '')}
        aria-pressed={marks.has(mark)}
        // Keeps focus (and the caret) in the composer, as Docs does.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onToggle(mark)}
      >
        <MIcon name={name} />
      </button>
    </Tip>
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
        {caret ? <MIcon name="arrow_drop_down" className="tb-caret" /> : null}
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
