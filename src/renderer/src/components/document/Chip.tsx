import type { ReactNode } from 'react'

import { MIcon } from '../ui/MaterialIcon'
import { Menu, MenuPopup, MenuTrigger } from '../ui/menu'

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
  menuWidth = 240,
  testId,
  title,
  align = 'start',
  children,
}: {
  label?: string
  icon?: ReactNode
  chevron?: boolean
  className?: string
  menuClass?: string
  menuWidth?: number
  testId: string
  title?: string
  align?: 'start' | 'end'
  children: ReactNode
}) {
  return (
    <Menu modal={false}>
      <MenuTrigger className={`chip${className ? ` ${className}` : ''}`} data-testid={testId} title={title}>
        {icon}
        {label !== undefined ? <span className="chip-label">{label}</span> : null}
        {chevron ? <MIcon name="arrow_drop_down" /> : null}
      </MenuTrigger>
      <MenuPopup align={align} className={`popover${menuClass ? ` ${menuClass}` : ''}`} style={{ width: menuWidth }}>
        {children}
      </MenuPopup>
    </Menu>
  )
}
