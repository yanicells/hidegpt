import { Fragment, type CSSProperties, type ReactNode } from 'react'

import { MIcon, type MaterialIconName } from './MaterialIcon'
import {
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from './menu'

/**
 * One Docs menu row. `icon` is the 20px leading glyph, `shortcut` the grey
 * right-hand hint, `submenu` turns the row into a ▸ cascade, and `divider`
 * draws the hairline separator above the row.
 */
export type Item = {
  id: string
  label: string
  run?: () => void
  disabled?: boolean
  checked?: boolean
  icon?: MaterialIconName
  shortcut?: string
  submenu?: Item[]
  divider?: boolean
  /** Extra text for the tooltip, e.g. what a costume label really selects. */
  title?: string
  /** Grey second line under the label (Docs' editing-mode menu). */
  description?: string
  /** Draw the ▸ without a cascade (style menu rows). */
  arrow?: boolean
  /** Run without closing the menu (e.g. paging inside a popover). */
  keepOpen?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * A Docs menu popup filled from `Item` rows. Use inside `<Menu>` next to its
 * `<MenuTrigger>`; `children` render above the rows (search fields, cards).
 */
export function MenuPanel({
  items,
  testId,
  itemPrefix = 'action',
  className,
  align = 'start',
  style,
  children,
}: {
  items: Item[]
  testId?: string
  itemPrefix?: string
  className?: string
  align?: 'start' | 'center' | 'end'
  style?: CSSProperties
  children?: ReactNode
}) {
  return (
    <MenuPopup align={align} className={className} data-testid={testId} style={style}>
      {children}
      <MenuRows items={items} itemPrefix={itemPrefix} />
    </MenuPopup>
  )
}

/** The rows alone, for popups that swap their contents (the style menu's Options page). */
export function MenuRows({ items, itemPrefix = 'action' }: { items: Item[]; itemPrefix?: string }) {
  return items.map((item, index) => (
    <Fragment key={item.id}>
      {item.divider && index > 0 ? <MenuSeparator /> : null}
      <Row item={item} itemPrefix={itemPrefix} />
    </Fragment>
  ))
}

function Row({ item, itemPrefix }: { item: Item; itemPrefix: string }) {
  const testId = `${itemPrefix}-${item.id}`
  const body = <RowBody item={item} />
  if (item.submenu) {
    return (
      <MenuSub>
        <MenuSubTrigger className={item.className} data-testid={testId} disabled={item.disabled} title={item.title}>
          {body}
        </MenuSubTrigger>
        <MenuSubPopup>
          <MenuRows items={item.submenu} itemPrefix={itemPrefix} />
        </MenuSubPopup>
      </MenuSub>
    )
  }
  const common = {
    className: item.className,
    'data-testid': testId,
    disabled: item.disabled,
    title: item.title,
    closeOnClick: !item.keepOpen,
    onClick: item.run,
  }
  return item.checked === undefined ? (
    <MenuItem {...common}>
      {body}
      {item.arrow ? <Arrow /> : null}
    </MenuItem>
  ) : (
    <MenuCheckboxItem {...common} checked={item.checked}>
      {body}
      {item.arrow ? <Arrow /> : null}
    </MenuCheckboxItem>
  )
}

function RowBody({ item }: { item: Item }) {
  return (
    <>
      <span className="menu-icon" aria-hidden="true">
        {item.checked ? <MIcon name="check" /> : item.icon ? <MIcon name={item.icon} /> : null}
      </span>
      <span className="menu-text" style={item.style}>
        {item.label}
        {item.description ? <span className="menu-desc">{item.description}</span> : null}
      </span>
      {item.shortcut ? <MenuShortcut>{item.shortcut}</MenuShortcut> : null}
    </>
  )
}

function Arrow() {
  return (
    <span className="menu-arrow" aria-hidden="true">
      <MIcon name="arrow_right" />
    </span>
  )
}
