import { MIcon } from '../ui/MaterialIcon'
import { Menu, MenuTrigger } from '../ui/menu'
import { MenuPanel, type Item } from '../ui/MenuPanel'
import { Tip } from '../ui/tooltip'

export type Owner = 'anyone' | 'me' | 'others'

const OWNERS: { id: Owner; label: string }[] = [
  { id: 'anyone', label: 'Owned by anyone' },
  { id: 'me', label: 'Owned by me' },
  { id: 'others', label: 'Not owned by me' },
]

/**
 * Docs' "Owned by anyone ▾" filter, with Docs' three choices. Every document
 * here is the user's own, so "Not owned by me" is always empty. Folders are
 * chosen from the file picker instead.
 */
export function OwnerMenu({ value, onChange }: { value: Owner; onChange: (owner: Owner) => void }) {
  const items: Item[] = OWNERS.map((owner) => ({
    id: owner.id,
    label: owner.label,
    checked: owner.id === value,
    run: () => onChange(owner.id),
  }))
  return (
    <Menu>
      <MenuTrigger className="owned-by-button" aria-label="Filter by owner" data-testid="home-location">
        <span>{OWNERS.find((owner) => owner.id === value)?.label}</span>
        <MIcon name="arrow_drop_down" size={24} />
      </MenuTrigger>
      <MenuPanel items={items} itemPrefix="owner" testId="panel-location" />
    </Menu>
  )
}

export type Sort = 'opened' | 'modified-by-me' | 'modified' | 'title'

/** Docs' sort choices. Every date sort orders by last update: that is the only time a document carries. */
export const SORTS: { id: Sort; label: string }[] = [
  { id: 'opened', label: 'Last opened by me' },
  { id: 'modified-by-me', label: 'Last modified by me' },
  { id: 'modified', label: 'Last modified' },
  { id: 'title', label: 'Title' },
]

/** The recents toolbar's A-Z button: opens Docs' sort menu with the current choice checked. */
export function SortMenu({ value, onChange }: { value: Sort; onChange: (sort: Sort) => void }) {
  const items: Item[] = SORTS.map((sort) => ({
    id: sort.id,
    label: sort.label,
    checked: sort.id === value,
    run: () => onChange(sort.id),
  }))
  return (
    <Menu>
      <Tip label="Sort options">
        <MenuTrigger className="icon-btn" aria-label="Sort options" data-testid="home-sort">
          <MIcon name="sort_by_alpha" size={24} />
        </MenuTrigger>
      </Tip>
      <MenuPanel items={items} itemPrefix="sort" testId="panel-sort" align="end" />
    </Menu>
  )
}
