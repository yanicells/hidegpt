import { MIcon } from '../ui/MaterialIcon'
import { Menu, MenuTrigger } from '../ui/menu'
import { MenuPanel, type Item } from '../ui/MenuPanel'

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
