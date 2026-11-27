import { describe, expect, it } from 'vitest'

import { matchesShortcut, SHORTCUTS, shortcutLabel } from './shortcuts'

const press = (
  key: string,
  code: string,
  mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>>,
) => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('matchesShortcut', () => {
  it('reads mod as Cmd on macOS and Ctrl elsewhere, with no extra modifiers', () => {
    expect(matchesShortcut(press('p', 'KeyP', { metaKey: true }), SHORTCUTS.print, 'darwin')).toBe(true)
    expect(matchesShortcut(press('p', 'KeyP', { ctrlKey: true }), SHORTCUTS.print, 'darwin')).toBe(false)
    expect(matchesShortcut(press('p', 'KeyP', { ctrlKey: true }), SHORTCUTS.print, 'win32')).toBe(true)
    expect(matchesShortcut(press('P', 'KeyP', { metaKey: true, shiftKey: true }), SHORTCUTS.print, 'darwin')).toBe(
      false,
    )
  })

  it('matches by physical key when the layout types something else', () => {
    // Cmd+P on a Russian layout types "з"; Cmd+/ on a German layout types "-".
    expect(matchesShortcut(press('з', 'KeyP', { metaKey: true }), SHORTCUTS.print, 'darwin')).toBe(true)
    expect(matchesShortcut(press('-', 'Slash', { metaKey: true }), SHORTCUTS.help, 'darwin')).toBe(true)
    expect(matchesShortcut(press('/', 'Digit7', { metaKey: true }), SHORTCUTS.help, 'darwin')).toBe(true)
  })
})

describe('shortcutLabel', () => {
  it('writes labels the way Docs menus print them', () => {
    expect(shortcutLabel({ key: 'k', mod: true }, 'darwin')).toBe('⌘K')
    expect(shortcutLabel({ key: 'v', mod: true, shift: true }, 'darwin')).toBe('⌘+Shift+V')
    expect(shortcutLabel({ key: 'm', mod: true, alt: true }, 'darwin')).toBe('⌘+Option+M')
    expect(shortcutLabel({ key: 'v', mod: true, shift: true }, 'win32')).toBe('Ctrl+Shift+V')
    expect(shortcutLabel({ key: '\\', mod: true }, 'linux')).toBe('Ctrl+\\')
  })
})
