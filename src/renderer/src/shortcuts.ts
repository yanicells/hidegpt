// `matchesShortcut` is adapted from T3 Code (packages/shared/src/keybindingMatching.ts,
// matchesKeybindingShortcut) at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License.

/**
 * The document's keyboard shortcuts, as Docs binds them. `mod` is Cmd on macOS
 * and Ctrl elsewhere. Find (Mod+F) belongs to the native Edit menu, which sends
 * the `find` menu action, so the page never handles that key itself; it is here
 * for its label. Mod+K (link) is not bound: the page is read-only, so a link
 * has nowhere to go, and the key does nothing, as Docs' toolbar tools do (S5).
 */
export type Shortcut = { key: string; mod?: boolean; shift?: boolean; alt?: boolean }

export const SHORTCUTS = {
  find: { key: 'f', mod: true },
  print: { key: 'p', mod: true },
  help: { key: '/', mod: true },
} as const satisfies Record<string, Shortcut>

export type ShortcutEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

const isMac = (platform: string) => platform === 'darwin'

/**
 * Whether `event` presses `shortcut`. Letters match by layout key or by
 * physical key (so Cmd+F still works on a non-Latin layout), and "/" by its
 * physical key, as T3 Code matches them.
 */
export function matchesShortcut(event: ShortcutEventLike, shortcut: Shortcut, platform: string): boolean {
  const mod = shortcut.mod === true
  const wantMeta = mod && isMac(platform)
  const wantCtrl = mod && !isMac(platform)
  if (
    event.metaKey !== wantMeta ||
    event.ctrlKey !== wantCtrl ||
    event.shiftKey !== (shortcut.shift === true) ||
    event.altKey !== (shortcut.alt === true)
  ) {
    return false
  }
  const key = event.key.toLowerCase()
  if (key === shortcut.key) return true
  const physical = event.code === 'Slash' ? '/' : event.code.match(/^Key([A-Z])$/)?.[1]?.toLowerCase()
  return physical === shortcut.key
}

/**
 * The label Docs prints beside a menu row: "⌘K" and "⌘+Shift+V" on macOS,
 * "Ctrl+K" and "Ctrl+Shift+V" elsewhere.
 */
export function shortcutLabel(shortcut: Shortcut, platform: string): string {
  const mac = isMac(platform)
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key
  const parts = [
    ...(shortcut.mod ? [mac ? '⌘' : 'Ctrl'] : []),
    ...(shortcut.shift ? ['Shift'] : []),
    ...(shortcut.alt ? [mac ? 'Option' : 'Alt'] : []),
  ]
  // Docs runs a lone ⌘ into its key ("⌘K") and joins anything longer with "+".
  if (mac && parts.length === 1 && shortcut.mod) return `⌘${key}`
  return [...parts, key].join('+')
}
