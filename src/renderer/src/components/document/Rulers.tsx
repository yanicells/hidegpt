import { memo } from 'react'

const INCH = 96
const EIGHTH = INCH / 8
const PAGE_WIDTH = 816
const PAGE_HEIGHT = 1056
const INCHES = [-1, 1, 2, 3, 4, 5, 6, 7]
const V_INCHES = [-1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

/**
 * Path data for a ruler `length` px long: a 1px tick every eighth of an inch,
 * 8px deep at each half inch and 4px elsewhere, split into the ticks over the
 * 1in margins (both ends included) and those over the content between them.
 */
export function rulerTicks(length: number, vertical: boolean): { margin: string; content: string } {
  const ticks = { margin: '', content: '' }
  const last = length / EIGHTH
  for (let k = 0; k <= last; k++) {
    const at = k * EIGHTH
    const depth = k % 8 === 4 ? 8 : 4
    const d = vertical ? `M${8 - depth} ${at}h${depth}v1h${-depth}z` : `M${at} ${8 - depth}h1v${depth}h-1z`
    ticks[at <= INCH || at >= length - INCH ? 'margin' : 'content'] += d
  }
  return ticks
}

const H_TICKS = rulerTicks(PAGE_WIDTH, false)
const V_TICKS = rulerTicks(PAGE_HEIGHT, true)

/** One ruler's ticks as a single static SVG, coloured by zone in ruler.css. */
function Ticks({ className, ticks }: { className: string; ticks: { margin: string; content: string } }) {
  return (
    <svg className={className}>
      <path className="ruler-tick-margin" d={ticks.margin} />
      <path className="ruler-tick-content" d={ticks.content} />
    </svg>
  )
}

/**
 * Docs' horizontal ruler over the page: inches count from the left margin,
 * ticks are darker over the margins, and blue markers sit at both indents.
 * Like Docs, each tick and number sits 1px left of its inch, on the page's
 * edge rather than inside it. Decorative, and static: memo keeps the
 * document's re-renders (one per streamed block) from reaching it.
 */
export const Ruler = memo(function Ruler() {
  return (
    <div className="ruler" aria-hidden="true">
      <div className="ruler-track">
        <Ticks className="ruler-ticks" ticks={H_TICKS} />
        {INCHES.map((inch) => (
          <span key={inch} className="ruler-num" style={{ left: INCH - 1 + inch * INCH }}>
            {Math.abs(inch)}
          </span>
        ))}
        <i className="ruler-indent ruler-indent-left" />
        <i className="ruler-indent ruler-indent-right" />
      </div>
    </div>
  )
})

/**
 * The vertical ruler along the left edge of the editor, numbered like the
 * horizontal one: "1" at the page's top edge, then inches from the top margin.
 * Its ticks start 16px down, 1px above the page's top edge. Decorative and
 * static, like Ruler.
 */
export const VerticalRuler = memo(function VerticalRuler() {
  return (
    <div className="vruler" aria-hidden="true">
      <Ticks className="vruler-ticks" ticks={V_TICKS} />
      {V_INCHES.map((inch) => (
        // Half a pixel below the tick, where Docs centres its numbers.
        <span key={inch} className="vruler-num" style={{ top: 16.5 + INCH + inch * INCH }}>
          {Math.abs(inch)}
        </span>
      ))}
    </div>
  )
})
