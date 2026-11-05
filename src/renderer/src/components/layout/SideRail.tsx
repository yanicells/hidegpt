import { RailIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'

const APPS = [
  { app: 'calendar', label: 'Calendar' },
  { app: 'keep', label: 'Keep' },
  { app: 'tasks', label: 'Tasks' },
  { app: 'contacts', label: 'Contacts' },
  { app: 'maps', label: 'Maps' },
] as const

/** Docs' right-hand side panel of Workspace apps. Decorative. */
export function SideRail() {
  return (
    <aside className="side-rail" aria-hidden="true">
      {APPS.map(({ app, label }) => (
        <span key={app} className="rail-app" title={label}>
          <RailIcon app={app} />
        </span>
      ))}
      <span className="rail-divider" />
      <span className="rail-app" title="Get add-ons">
        <MIcon name="add" />
      </span>
      <span className="rail-app rail-hide" title="Hide side panel">
        <MIcon name="chevron_right" />
      </span>
    </aside>
  )
}
