/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { emptySnapshot } from '../../../../shared/model'
import { Toolbar } from './Toolbar'

import '@testing-library/jest-dom/vitest'

afterEach(cleanup)

describe('formatting toggles', () => {
  it('presses and releases Bold, Italic and Underline on their own', async () => {
    const user = userEvent.setup()
    render(<Toolbar snap={emptySnapshot()} />)
    const [bold, italic, underline] = ['Bold', 'Italic', 'Underline'].map((name) =>
      screen.getByRole('button', { name }),
    )
    // The mousedown is cancelled, so pressing one leaves focus in the composer.
    expect(fireEvent.mouseDown(bold)).toBe(false)

    await user.click(bold)
    await user.click(underline)
    expect(bold).toHaveAttribute('aria-pressed', 'true')
    expect(italic).toHaveAttribute('aria-pressed', 'false')
    expect(underline).toHaveAttribute('aria-pressed', 'true')

    await user.click(bold)
    expect(bold).toHaveAttribute('aria-pressed', 'false')
    expect(underline).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows the same state in the ⋮ row as in the pill', async () => {
    const user = userEvent.setup()
    const { container } = render(<Toolbar snap={emptySnapshot()} />)
    await user.click(screen.getByRole('button', { name: 'Italic' }))
    await user.click(screen.getByTestId('toolbar-more'))

    // The row portals into the wrap, the container its fold steps query, outside the clipping pill.
    const row = container.querySelector<HTMLElement>('.toolbar-wrap .toolbar-overflow')
    expect(row).not.toBeNull()
    expect(row!.closest('.toolbar')).toBeNull()
    const italic = within(row!).getByRole('button', { name: 'Italic' })
    expect(italic).toHaveAttribute('aria-pressed', 'true')

    await user.click(italic)
    expect(screen.getAllByRole('button', { name: 'Italic' })).toHaveLength(2)
    for (const copy of screen.getAllByRole('button', { name: 'Italic' })) {
      expect(copy).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('leaves focus in the composer while the ⋮ row opens, is used and closes', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Toolbar snap={emptySnapshot()} />
        <textarea aria-label="Composer" />
      </>,
    )
    const composer = screen.getByRole('textbox', { name: 'Composer' })
    composer.focus()

    await user.click(screen.getByTestId('toolbar-more'))
    const row = await screen.findByRole('dialog', { name: 'More tools' })
    expect(composer).toHaveFocus()

    await user.click(within(row).getByRole('button', { name: 'Bold' }))
    expect(composer).toHaveFocus()

    await user.click(screen.getByTestId('toolbar-more'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'More tools' })).toBeNull())
    expect(composer).toHaveFocus()
  })
})
