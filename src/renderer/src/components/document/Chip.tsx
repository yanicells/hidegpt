import type { ReactNode } from 'react'

import { cn } from '../ui/cn'
import { MIcon } from '../ui/MaterialIcon'
import { Menu, MenuPopup, MenuTrigger } from '../ui/menu'
import { Tip } from '../ui/tooltip'

/**
 * A toolbar dropdown ("Normal text ▾", "Arial ▾", "11", "✎ ▾"). The trigger
 * looks like a Docs toolbar chip; `children` fill its popup (usually
 * `<MenuRows>`), which Base UI portals, places and dismisses.
 */
export function Chip({
  label,
  icon,
  chevron = true,
  className,
  menuClass,
  testId,
  tip,
  align = 'start',
  children,
}: {
  label?: string
  icon?: ReactNode
  chevron?: boolean
  className?: string
  /** Popup class; its width lives with the rest of that menu's CSS. */
  menuClass?: string
  testId: string
  /** The hover label (Docs' "Styles", "Font"). */
  tip?: string
  align?: 'start' | 'end'
  children: ReactNode
}) {
  return (
    <Menu modal={false}>
      <Tip label={tip}>
        <MenuTrigger className={cn('chip', className)} data-testid={testId}>
          {icon}
          {label !== undefined ? <span className="chip-label">{label}</span> : null}
          {chevron ? <MIcon name="arrow_drop_down" /> : null}
        </MenuTrigger>
      </Tip>
      <MenuPopup align={align} className={cn('popover', menuClass)}>
        {children}
      </MenuPopup>
    </Menu>
  )
}
