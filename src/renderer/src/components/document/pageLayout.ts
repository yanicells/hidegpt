/** US Letter at 96dpi, Docs' 16px grey gap between sheets, and the 1in margins. */
export const PAGE_HEIGHT = 1056
const PAGE_GAP = 16
export const PAGE_PITCH = PAGE_HEIGHT + PAGE_GAP
const MARGIN = 96

/** Docs' "prevent single lines": a split paragraph keeps at least two lines on each page. */
const MIN_LINES = 2

/**
 * Something that paginates, as it would sit with its row's breaks removed. Offsets are from
 * the row's border-box top as laid out now, which only a row that is itself one unit moves
 * (its break is its own top margin), so for that row the offset is minus its push.
 */
export type PageUnit<E> = { el: E; offset: number; height: number; heading: boolean; paragraph: boolean }

/**
 * One row of the page (a block, the composer, ...), as laid out right now, in page px.
 * `live` rows are rendered, so a break written into one moves everything after it this
 * frame; a row skipped by `content-visibility` keeps its size until it renders again.
 * `measured` is the cached geometry, or null for a row never measured, whose breaks stay as they are.
 * `applied` is how far the breaks currently written into a live row push what follows it.
 */
export type PageRow<E> = {
  top: number
  height: number
  live: boolean
  measured: { units: PageUnit<E>[]; height: number } | null
  applied: number
}

/** Line tops relative to the paragraph's top. */
export type Lines = { tops: number[]; lineHeight: number }

/**
 * A unit pushed whole onto the next page (`margin` replaces its top margin), or a paragraph
 * broken between lines (`start`/`end` bound the band its float covers). `push` is how far
 * the break moves everything after it.
 */
export type PageBreak<E> =
  | { kind: 'push'; el: E; margin: number; push: number }
  | { kind: 'split'; el: E; start: number; end: number; push: number }

export type PageLayout<E> = {
  /** Per row, its breaks, or null to keep the ones it has. */
  breaks: (PageBreak<E>[] | null)[]
  pages: number
}

type Placed<E> = { unit: PageUnit<E>; row: number; future: number; gap: number }

/**
 * Where every break goes, from cached geometry and the current layout only, so it reads
 * nothing inside an off-screen row. `shift` is how far a position will move once this
 * pass's breaks replace the ones in effect: each break adds its push, and at the end of a
 * live row the pushes it already had come back off, since the next row's top includes them.
 * A skipped row's breaks are recomputed for when it renders, but move nothing now.
 */
export function layoutPages<E>(
  rows: PageRow<E>[],
  linesOf: (unit: PageUnit<E>, row: number) => Lines | null,
): PageLayout<E> {
  const breaks: (PageBreak<E>[] | null)[] = []
  let shift = 0
  let bottom = 0
  // Where the margin a push replaces starts: the previous unit's bottom without breaks
  // inside a row, or the previous row's bottom, since a row keeps its margins inside it.
  let above = MARGIN
  let previous: Placed<E> | undefined

  rows.forEach((row, index) => {
    const start = shift
    if (!row.measured) {
      breaks.push(null)
      bottom = Math.max(bottom, row.top + shift + row.height)
      above = row.top + row.height
      previous = undefined
      return
    }
    const own: PageBreak<E>[] = []
    breaks.push(own)
    for (const unit of row.measured.units) {
      const top = row.top + unit.offset
      const placed: Placed<E> = { unit, row: index, future: top + shift, gap: top - above }
      const page = Math.floor(placed.future / PAGE_PITCH)
      const limit = page * PAGE_PITCH + PAGE_HEIGHT - MARGIN
      const nextTop = (page + 1) * PAGE_PITCH + MARGIN
      if (placed.future + unit.height > limit) {
        const split = unit.paragraph ? splitAt(linesOf(unit, index), placed.future, limit) : null
        if (split !== null) {
          const push = nextTop - (placed.future + split)
          // The band starts a pixel into the line so rounding can't catch the line above.
          own.push({ kind: 'split', el: unit.el, start: split + 1, end: split + push, push })
          shift += push
        } else if (unit.height <= PAGE_HEIGHT - 2 * MARGIN) {
          // Docs keeps a heading with the paragraph after it, so the heading moves too,
          // when moving it changes the layout now: in this row or a rendered one.
          const keep =
            previous !== undefined &&
            previous.unit.heading &&
            (previous.row === index || rows[previous.row].live) &&
            breaks[previous.row]?.at(-1)?.el !== previous.unit.el &&
            Math.floor(previous.future / PAGE_PITCH) === page
          const lead = keep && previous ? previous : placed
          const push = nextTop - lead.future
          breaks[lead.row]!.push({ kind: 'push', el: lead.unit.el, margin: lead.gap + push, push })
          shift += push
        }
        // Otherwise it is taller than a page's text area and has to cross the break.
      }
      if (row.live) bottom = Math.max(bottom, top + shift + unit.height)
      above = top + unit.height
      previous = placed
    }
    if (row.live) {
      shift -= row.applied
    } else {
      bottom = Math.max(bottom, row.top + start + row.height)
      shift = start
    }
    above = row.top + row.height
  })
  return { breaks, pages: Math.floor(bottom / PAGE_PITCH) + 1 }
}

/**
 * Where a paragraph whose top will sit at `top` should break to stay inside `limit`: the
 * offset of its first line that doesn't fit, or null when either side would keep fewer
 * than MIN_LINES lines.
 */
function splitAt(lines: Lines | null, top: number, limit: number): number | null {
  if (!lines?.lineHeight) return null
  const first = lines.tops.findIndex((line) => top + line + lines.lineHeight > limit)
  const at = Math.min(first, lines.tops.length - MIN_LINES)
  return first >= 0 && at >= MIN_LINES ? lines.tops[at] : null
}
