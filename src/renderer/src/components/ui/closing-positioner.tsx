/*
 * Adapted from T3 Code (apps/web/src/components/ui/closing-positioner.tsx).
 * Copyright (c) 2026 T3 Tools Inc. Licensed under the MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { useState, type ComponentProps, type CSSProperties } from 'react'

const PLACEMENT_KEYS = ['position', 'top', 'right', 'bottom', 'left', 'transform'] as const

type Placement = Pick<CSSProperties, (typeof PLACEMENT_KEYS)[number]>

/** Freezes a closing popup where it was, so it never jumps while it fades out. */
function ClosingPositioner({ open, style, ...props }: ComponentProps<'div'> & { open: boolean }) {
  const [openPlacement, setOpenPlacement] = useState<Placement>({})
  if (open && style && PLACEMENT_KEYS.some((key) => style[key] !== openPlacement[key])) {
    const { position, top, right, bottom, left, transform } = style
    setOpenPlacement({ position, top, right, bottom, left, transform })
  }
  return <div {...props} style={open ? style : { ...style, ...openPlacement }} />
}

export function renderClosingPositioner(props: ComponentProps<'div'>, state: { open: boolean }) {
  return <ClosingPositioner {...props} open={state.open} />
}
