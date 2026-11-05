import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { MenuRows, type Item } from '../ui/MenuPanel'
import { EDIT_MODES, styleSlots } from './toolbarMenus'

/**
 * "Normal text ▾": each Docs paragraph style is a model slot. Clicking a slot
 * picks its model; its ▸ holds Docs' "Update / Apply" rows, and the model's
 * real name waits in the row's tooltip. Slots without a model are plain styles.
 */
export function StyleMenu({ snap }: { snap: Snapshot }) {
  const items: Item[] = [
    ...styleSlots(snap.models.length).map((slot, index) => {
      const item = snap.models[index]
      const run = item ? () => dispatch({ op: 'setModel', model: item.model }) : undefined
      return {
        id: item?.model ?? `style-${index}`,
        label: slot.name,
        className: slot.className,
        tip: item?.displayName,
        checked: item ? item.model === snap.model : undefined,
        run,
        submenu: [
          { id: `update-${index}`, label: `Update '${slot.name}' to match` },
          { id: `apply-${index}`, label: `Apply '${slot.name}'`, run },
        ],
      }
    }),
    {
      id: 'options',
      label: 'Options',
      className: 'style-options',
      submenu: [
        { id: 'save-styles', label: 'Save as my default styles' },
        { id: 'use-styles', label: 'Use my default styles' },
        { id: 'reset-styles', label: 'Reset styles' },
      ],
    },
  ]
  return <MenuRows items={items} itemPrefix="pick" />
}

/** The pencil menu: Docs' Editing / Suggesting / Viewing, standing in for modes. */
export function ModeMenu({ snap }: { snap: Snapshot }) {
  const modes = snap.collaborationModes
  const items: Item[] =
    modes.length > 1
      ? modes.map((mode, index) => ({
          id: mode.name,
          label: EDIT_MODES[index]?.label ?? mode.name,
          icon: EDIT_MODES[index]?.icon ?? 'edit_note',
          description: EDIT_MODES[index]?.description,
          tip: mode.name,
          checked: mode.name === snap.collaborationMode,
          run: () => dispatch({ op: 'setCollaborationMode', name: mode.name }),
        }))
      : EDIT_MODES.map((mode, index) => ({
          id: mode.label.toLowerCase(),
          label: mode.label,
          icon: mode.icon,
          description: mode.description,
          checked: index === 0,
        }))
  return <MenuRows items={items} itemPrefix="pick" />
}
