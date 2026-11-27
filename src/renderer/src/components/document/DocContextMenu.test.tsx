/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import type { HideGptApi } from '../../../../shared/api'
import { DocContextMenu } from './DocContextMenu'
// Loaded up front, as the app's bridge would be, so its lazy import resolves at once.
import './DocContextPopup'

import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
  getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount() {
  window.hidegpt = { platform: 'darwin' } as Partial<HideGptApi> as HideGptApi
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  onTestFinished(() => void Reflect.deleteProperty(navigator, 'clipboard'))
  function Harness() {
    const pageRef = useRef<HTMLElement>(null)
    return (
      <>
        <article ref={pageRef}>
          <p data-testid="text">Photosynthesis turns light into sugar.</p>
          <textarea data-testid="composer" defaultValue="draft text" />
        </article>
        <p data-testid="outside">Not the page.</p>
        <DocContextMenu pageRef={pageRef} />
      </>
    )
  }
  render(<Harness />)
  return { writeText }
}

const row = (id: string) => screen.getByTestId(`context-${id}`)

function select(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  getSelection()?.removeAllRanges()
  getSelection()?.addRange(range)
}

describe('DocContextMenu', () => {
  it("opens Docs' rows on a right click in the page, disabling the ones a read-only page can't do", async () => {
    mount()
    fireEvent.contextMenu(screen.getByTestId('text'), { clientX: 200, clientY: 300 })
    await screen.findByTestId('doc-context-menu')

    for (const id of ['cut', 'copy', 'paste', 'paste-plain', 'delete', 'comment', 'link', 'clear']) {
      expect(row(id)).toHaveAttribute('data-disabled')
    }
    expect(row('help-me-write')).not.toHaveAttribute('data-disabled')
    expect(row('paste-plain')).toHaveTextContent('⌘+Shift+V')
    expect(row('link')).toHaveTextContent('⌘K')
  })

  it('copies a selection in the page and names the word for Define', async () => {
    const { writeText } = mount()
    select(screen.getByTestId('text').firstChild!)
    fireEvent.contextMenu(screen.getByTestId('text'))
    await screen.findByTestId('doc-context-menu')
    expect(row('cut')).toHaveAttribute('data-disabled')
    expect(row('define')).toHaveTextContent('Define')

    fireEvent.click(row('copy'))
    expect(writeText).toHaveBeenCalledWith('Photosynthesis turns light into sugar.')
    await waitFor(() => expect(screen.queryByTestId('doc-context-menu')).not.toBeInTheDocument())

    // A single selected word is what Define looks up.
    const word = document.createRange()
    word.setStart(screen.getByTestId('text').firstChild!, 0)
    word.setEnd(screen.getByTestId('text').firstChild!, 14)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(word)
    fireEvent.contextMenu(screen.getByTestId('text'))
    expect(await screen.findByTestId('context-define')).toHaveTextContent("Define 'Photosynthesis'")
  })

  it('cuts and deletes only in the writing line', async () => {
    const { writeText } = mount()
    // jsdom has no execCommand; Chromium's runs the edit and fires the input event React reads.
    const exec = vi.fn((_command: string) => true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    onTestFinished(() => void Reflect.deleteProperty(document, 'execCommand'))
    const composer = screen.getByTestId<HTMLTextAreaElement>('composer')
    composer.setSelectionRange(0, 5)
    fireEvent.contextMenu(composer)
    await screen.findByTestId('doc-context-menu')
    expect(row('paste')).toHaveAttribute('data-disabled')

    fireEvent.click(row('cut'))
    expect(writeText).toHaveBeenCalledWith('draft')
    expect(exec).toHaveBeenCalledWith('delete')
    expect([composer.selectionStart, composer.selectionEnd]).toEqual([0, 5])
  })

  it('ignores right clicks outside the page', () => {
    mount()
    act(() => {
      fireEvent.contextMenu(screen.getByTestId('outside'))
    })
    expect(screen.queryByTestId('doc-context-menu')).not.toBeInTheDocument()
  })
})
