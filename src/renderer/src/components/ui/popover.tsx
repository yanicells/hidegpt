/*
 * Adapted from T3 Code (apps/web/src/components/ui/popover.tsx).
 * Copyright (c) 2026 T3 Tools Inc. Licensed under the MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { Popover as PopoverPrimitive } from '@base-ui/react/popover'

import { renderClosingPositioner } from './closing-positioner'
import { cn, type Styled } from './cn'

/** A non-menu floating panel (the account switcher): portaled, placed and dismissed by Base UI. */
const Popover = PopoverPrimitive.Root

function PopoverTrigger({ className, ...props }: Styled<PopoverPrimitive.Trigger.Props>) {
  return <PopoverPrimitive.Trigger className={className} data-slot="popover-trigger" {...props} />
}

function PopoverPopup({
  children,
  className,
  side = 'bottom',
  align = 'end',
  sideOffset = 4,
  ...props
}: Styled<PopoverPrimitive.Popup.Props> & {
  side?: PopoverPrimitive.Positioner.Props['side']
  align?: PopoverPrimitive.Positioner.Props['align']
  sideOffset?: PopoverPrimitive.Positioner.Props['sideOffset']
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        className="menu-positioner"
        collisionPadding={8}
        render={renderClosingPositioner}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup className={cn('popover-panel', className)} data-slot="popover-popup" {...props}>
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverClose(props: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />
}

export { Popover, PopoverClose, PopoverPopup, PopoverTrigger }
