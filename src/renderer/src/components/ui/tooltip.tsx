/*
 * Adapted from T3 Code (apps/web/src/components/ui/tooltip.tsx).
 * Copyright (c) 2026 T3 Tools Inc. Licensed under the MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import type { ReactElement } from 'react'

// Base UI's default, restated because a padding object zeroes the sides it omits.
const COLLISION_PADDING = 5

/** Shares the hover delay, so moving along the toolbar shows each tip at once, as Docs does. */
export const TooltipProvider = TooltipPrimitive.Provider

/**
 * Docs' dark hover label ("Undo (⌘Z)") under a control. `children` is the
 * control itself, which becomes the trigger and keeps its own props and
 * test ids; any trigger works, menu and popover triggers included. Without
 * a `label` the control renders unchanged.
 */
export function Tip({
  label,
  side = 'bottom',
  children,
}: {
  label?: string
  side?: TooltipPrimitive.Positioner.Props['side']
  children: ReactElement
}) {
  if (!label) return children
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          className="tooltip-positioner"
          collisionPadding={COLLISION_PADDING}
          side={side}
          sideOffset={4}
        >
          <TooltipPrimitive.Popup className="tooltip" data-slot="tooltip-popup">
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
