import type { SVGProps } from 'react'

import { SYMBOLS, type SymbolName } from './symbols'

export type MaterialIconName = SymbolName

/** The optical size a glyph drawn at `size` px uses: the 20px cut up to 20, the 24px cut above. */
export const opticalSize = (size: number): 20 | 24 => (size <= 20 ? 20 : 24)

/**
 * A Material Symbols Outlined glyph (weight 400), the icon set Docs uses.
 * Sizes up to 20px use the 20px optical size, larger ones the 24px cut.
 * symbols.ts carries only the cuts the renderer draws (MaterialIcon.test.ts checks).
 * `size` is used as given, so fractional sizes (Docs draws some at 14.4) stay exact.
 * Like T3 Code's icons, extra SVG props pass straight through.
 */
export function MIcon({
  name,
  size = 20,
  ...props
}: Omit<SVGProps<SVGSVGElement>, 'name'> & { name: MaterialIconName; size?: number }) {
  const cuts: Partial<Record<20 | 24, string>> = SYMBOLS[name]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d={cuts[opticalSize(size)]} />
    </svg>
  )
}
