const INCHES = [-1, 1, 2, 3, 4, 5, 6, 7]

/**
 * Docs' horizontal ruler over the page: inches count from the left margin,
 * the margins are shaded, and blue markers sit at both indents. Decorative.
 */
export function Ruler() {
  return (
    <div className="ruler" aria-hidden="true">
      <div className="ruler-track">
        {INCHES.map((inch) => (
          <span key={inch} className="ruler-num" style={{ left: 96 + inch * 96 }}>
            {Math.abs(inch)}
          </span>
        ))}
        <i className="ruler-indent ruler-indent-left" />
        <i className="ruler-indent ruler-indent-right" />
      </div>
    </div>
  )
}

/** The vertical ruler along the left edge of the editor. Decorative. */
export function VerticalRuler() {
  return (
    <div className="vruler" aria-hidden="true">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((inch) => (
        <span key={inch} className="vruler-num" style={{ top: 96 + inch * 96 }}>
          {inch}
        </span>
      ))}
    </div>
  )
}
