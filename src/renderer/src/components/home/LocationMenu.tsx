import { MIcon } from '../ui/MaterialIcon'
import { Menu, MenuTrigger } from '../ui/menu'
import { MenuPanel, type Item } from '../ui/MenuPanel'

export type Folder = { id: string; name: string; count: number }

/**
 * Docs' "Owned by anyone ▾" filter. Projects show up as Drive folders under a
 * divider; "My Drive" holds documents outside any project.
 */
export function LocationMenu({
  folders,
  value,
  onChange,
}: {
  folders: Folder[]
  value: string
  onChange: (id: string) => void
}) {
  const label =
    value === 'all' ? 'Owned by anyone' : value === 'loose' ? 'My Drive' : (folders.find((f) => f.id === value)?.name ?? 'Owned by anyone')
  const items: Item[] = [
    { id: 'all', label: 'Owned by anyone', checked: value === 'all', run: () => onChange('all') },
    { id: 'loose', label: 'My Drive', checked: value === 'loose', run: () => onChange('loose') },
    ...folders.map((folder, index) => ({
      id: folder.id,
      label: folder.name,
      icon: 'folder' as const,
      divider: index === 0,
      checked: value === folder.id,
      run: () => onChange(folder.id),
    })),
  ]
  return (
    <Menu>
      <MenuTrigger className="owned-by-button" aria-label="Filter by owner or folder" data-testid="home-location">
        <span>{label}</span>
        <MIcon name="arrow_drop_down" size={24} />
      </MenuTrigger>
      <MenuPanel items={items} itemPrefix="project" testId="panel-location" className="location-menu" />
    </Menu>
  )
}
