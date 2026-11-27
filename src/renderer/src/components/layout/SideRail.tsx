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
        <span className="rail-app rail-add">
          {/* Docs' plus: 14px across, 1.6px strokes, thinner than Material's 2px `add`. */}
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 11.2h14v1.6H5zM11.2 5h1.6v14h-1.6z" fill="currentColor" />
          </svg>
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
