import { RailIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'
import { Tip } from '../ui/tooltip'

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
        <Tip key={app} label={label} side="left">
          <span className="rail-app">
            <RailIcon app={app} />
          </span>
        </Tip>
      ))}
      <span className="rail-divider" />
      <Tip label="Get add-ons" side="left">
        <span className="rail-app">
          <MIcon name="add" />
        </span>
      </Tip>
      <Tip label="Hide side panel" side="left">
        <span className="rail-app rail-hide">
          <MIcon name="chevron_right" />
        </span>
      </Tip>
    </aside>
  )
}
