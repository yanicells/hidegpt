/*
 * Adapted from T3 Code (apps/web/src/components/ui/menu.tsx).
 * Copyright (c) 2026 T3 Tools Inc. Licensed under the MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import type { ComponentProps, KeyboardEvent, ReactNode } from 'react'

import { renderClosingPositioner } from './closing-positioner'
import { cn } from './cn'
import { MIcon } from './MaterialIcon'

/** Base UI also accepts a className function; these wrappers take plain strings. */
type Styled<P> = Omit<P, 'className'> & { className?: string }

/**
 * Docs-styled menu primitives on Base UI: portaled, collision-aware popups
 * with roving focus, typeahead, hover submenus and outside-click dismissal.
 * Looks live in styles/menus.css, keyed by these class names.
 */
const Menu = MenuPrimitive.Root

function MenuTrigger({ className, ...props }: Styled<MenuPrimitive.Trigger.Props>) {
  return <MenuPrimitive.Trigger className={className} data-slot="menu-trigger" {...props} />
}

function MenuPopup({
  children,
  className,
  sideOffset = 2,
  align = 'start',
  alignOffset,
  side = 'bottom',
  ...props
}: Styled<MenuPrimitive.Popup.Props> & {
  align?: MenuPrimitive.Positioner.Props['align']
  sideOffset?: MenuPrimitive.Positioner.Props['sideOffset']
  alignOffset?: MenuPrimitive.Positioner.Props['alignOffset']
  side?: MenuPrimitive.Positioner.Props['side']
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="menu-positioner"
        collisionPadding={8}
        render={renderClosingPositioner}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup className={cn('menu-panel', className)} data-slot="menu-popup" {...props}>
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

/** A menu's filter field. Letters stay in the field instead of driving typeahead. */
function MenuSearchInput({
  onKeyDown,
  ...props
}: Omit<ComponentProps<'input'>, 'className' | 'type'>) {
  return (
    <div className="menu-search">
      <MIcon name="search" />
      <input
        {...props}
        type="search"
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          // Menu typeahead would otherwise take the letters; arrows still reach the items.
          if (event.key !== 'ArrowDown' && event.key !== 'Escape') event.stopPropagation()
          onKeyDown?.(event)
        }}
      />
    </div>
  )
}

function MenuItem({ className, ...props }: Styled<MenuPrimitive.Item.Props>) {
  return <MenuPrimitive.Item className={cn('menu-item', className)} data-slot="menu-item" {...props} />
}

function MenuCheckboxItem({ className, ...props }: Styled<MenuPrimitive.CheckboxItem.Props>) {
  return (
    <MenuPrimitive.CheckboxItem
      className={cn('menu-item', className)}
      data-slot="menu-checkbox-item"
      {...props}
    />
  )
}

function MenuSeparator({ className, ...props }: Styled<MenuPrimitive.Separator.Props>) {
  return <MenuPrimitive.Separator className={cn('menu-separator', className)} data-slot="menu-separator" {...props} />
}

function MenuShortcut({ className, ...props }: ComponentProps<'kbd'>) {
  return <kbd className={cn('menu-shortcut', className)} data-slot="menu-shortcut" {...props} />
}

function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot {...props} />
}

function MenuSubTrigger({ className, children, ...props }: Styled<MenuPrimitive.SubmenuTrigger.Props> & { children?: ReactNode }) {
  return (
    <MenuPrimitive.SubmenuTrigger className={cn('menu-item', className)} data-slot="menu-sub-trigger" {...props}>
      {children}
      <span className="menu-arrow" aria-hidden="true">
        <MIcon name="arrow_right" />
      </span>
    </MenuPrimitive.SubmenuTrigger>
  )
}

function MenuSubPopup({ className, ...props }: Styled<MenuPrimitive.Popup.Props>) {
  // Docs cascades overlap their parent by a few pixels and line up with the row.
  return <MenuPopup align="start" alignOffset={-6} className={className} side="inline-end" sideOffset={-4} {...props} />
}

export {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSearchInput,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
}
