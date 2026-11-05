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
  useMenuClose,
} from './menu'
import { Tip } from './tooltip'

/**
 * One Docs menu row. `icon` is the 20px leading glyph, `shortcut` the grey
 * right-hand hint, `submenu` turns the row into a ▸ cascade (a cascade row
 * with `run` still acts on click, like Docs' style rows), and `divider` draws
 * the hairline separator above the row.
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
  /** A hover label, e.g. what a costume row really selects. */
  tip?: string
  /** Grey second line under the label (Docs' editing-mode menu). */
  description?: string
  /** A small blue pill after the label, like Docs' "New". */
  badge?: string
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
  const close = useMenuClose()
  const testId = `${itemPrefix}-${item.id}`
  const body = <RowBody item={item} />
  if (item.submenu) {
    const { run } = item
    return (
      <MenuSub>
        <Tip label={item.tip} side="right">
          <MenuSubTrigger
            className={item.className}
            data-testid={testId}
            disabled={item.disabled}
            // Shades the current choice like a checked row (the style menu's slots).
            data-checked={item.checked ? '' : undefined}
            onClick={
              run
                ? () => {
                    run()
                    close()
                  }
                : undefined
            }
          >
            {body}
          </MenuSubTrigger>
        </Tip>
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
    closeOnClick: true,
    onClick: item.run,
  }
  return (
    <Tip label={item.tip} side="right">
      {item.checked === undefined ? (
        <MenuItem {...common}>{body}</MenuItem>
      ) : (
        <MenuCheckboxItem {...common} checked={item.checked}>
          {body}
        </MenuCheckboxItem>
      )}
    </Tip>
  )
}

/** A row's icon column holds its icon, or ✓ when a checkable row has none (rows with icons show checked by highlight). */
function RowBody({ item }: { item: Item }) {
  return (
    <>
      <span className="menu-icon" aria-hidden="true">
        {item.icon ? <MIcon name={item.icon} /> : item.checked ? <MIcon name="check" /> : null}
      </span>
      <span className="menu-text" style={item.style}>
        {item.label}
        {item.description ? <span className="menu-desc">{item.description}</span> : null}
      </span>
      {item.badge ? <span className="menu-badge">{item.badge}</span> : null}
      {item.shortcut ? <MenuShortcut>{item.shortcut}</MenuShortcut> : null}
    </>
  )
}
