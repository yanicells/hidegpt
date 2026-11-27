/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HideGptApi } from '../../../../shared/api'
import { DocShortcuts } from './DocShortcuts'
// Loaded up front, so the dialog's lazy import resolves at once.
import './ShortcutsDialog'

import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mount() {
  window.hidegpt = { platform: 'darwin' } as Partial<HideGptApi> as HideGptApi
  const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)
  render(<DocShortcuts />)
  return { print }
}

describe('DocShortcuts', () => {
  it('prints on Cmd+P and takes the key from the window', () => {
    const { print } = mount()
    const event = new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', metaKey: true, cancelable: true })
    window.dispatchEvent(event)
    expect(print).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)

    // Ctrl+P is not the macOS shortcut.
    fireEvent.keyDown(window, { key: 'p', code: 'KeyP', ctrlKey: true })
    expect(print).toHaveBeenCalledOnce()
  })

  it('lists the working shortcuts on Cmd+/', async () => {
    mount()
    fireEvent.keyDown(window, { key: '/', code: 'Slash', metaKey: true })
    const dialog = await screen.findByTestId('shortcuts-dialog')
    expect(dialog).toHaveTextContent('Keyboard shortcuts')
    expect(dialog).toHaveTextContent('Find⌘F')
    expect(dialog).toHaveTextContent('Print⌘P')
  })
})
