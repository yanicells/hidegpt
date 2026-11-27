import type { SVGProps } from 'react'

import { SYMBOLS, type SymbolName } from './symbols'

export type MaterialIconName = SymbolName

/**
 * A Material Symbols Outlined glyph (weight 400), the icon set Docs uses.
 * Sizes up to 20px use the 20px optical size, larger ones the 24px cut.
 * `size` is used as given, so fractional sizes (Docs draws some at 14.4) stay exact.
 * Like T3 Code's icons, extra SVG props pass straight through.
 */
export function MIcon({
  name,
  size = 20,
  ...props
}: Omit<SVGProps<SVGSVGElement>, 'name'> & { name: MaterialIconName; size?: number }) {
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
      <path d={SYMBOLS[name][size <= 20 ? 20 : 24]} />
    </svg>
  )
}
