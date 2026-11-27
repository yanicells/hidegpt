/** @vitest-environment jsdom */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { emptySnapshot } from '../../../../shared/model'
import { Toolbar } from './Toolbar'

import '@testing-library/jest-dom/vitest'

afterEach(cleanup)

/** Opens a tool's menu from the pill (the ⋮ row's copy is the second match once that row is open). */
async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string, copy = 0) {
  await user.click(screen.getAllByRole('button', { name })[copy]!)
  return screen.findByRole('menu')
}

describe('toolbar tool menus', () => {
  it('moves the align pick, and the ⋮ row shows the same pick', async () => {
    const user = userEvent.setup()
    render(<Toolbar snap={emptySnapshot()} />)

    let menu = await openMenu(user, 'Align & indent')
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(4)
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Center align' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await user.click(screen.getByTestId('toolbar-more'))
    menu = await openMenu(user, 'Align & indent', 1)
    expect(within(menu).getByRole('menuitemradio', { name: 'Center align' })).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByRole('menuitemradio', { name: 'Left align' })).toHaveAttribute('aria-checked', 'false')
  })

  it('checks one line spacing and toggles the pagination rows; the other rows only close', async () => {
    const user = userEvent.setup()
    render(<Toolbar snap={emptySnapshot()} />)

    let menu = await openMenu(user, 'Line & paragraph spacing')
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Double' }))
    menu = await openMenu(user, 'Line & paragraph spacing')
    const checked = within(menu)
      .getAllByRole('menuitemcheckbox')
      .filter((row) => row.getAttribute('aria-checked') === 'true')
      .map((row) => row.textContent)
    expect(checked).toContain('Double')
    expect(checked).not.toContain('1.15')

    const keep = within(menu).getByRole('menuitemcheckbox', { name: 'Keep with next' })
    const wasOn = keep.getAttribute('aria-checked') === 'true'
    await user.click(keep)
    menu = await openMenu(user, 'Line & paragraph spacing')
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Keep with next' })).toHaveAttribute(
      'aria-checked',
      String(!wasOn),
    )

    await user.click(within(menu).getByRole('menuitem', { name: 'Custom spacing' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('opens each list grid from its caret, and the bullets grid cascades to the checklist grid', async () => {
    const user = userEvent.setup()
    render(<Toolbar snap={emptySnapshot()} />)

    for (const [name, cells] of [
      ['Checklist menu', 2],
      ['Numbered list menu', 6],
    ] as const) {
      const menu = await openMenu(user, name)
      expect(within(menu).getAllByRole('menuitem')).toHaveLength(cells)
      await user.click(within(menu).getAllByRole('menuitem')[0]!)
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    }

    const bullets = await openMenu(user, 'Bulleted list menu')
    expect(within(bullets).getByRole('menuitem', { name: 'Disc, circle, square' })).toBeInTheDocument()
    await user.click(within(bullets).getByTestId('bullets-checklist'))
    const cascade = await waitFor(() => {
      const menus = screen.getAllByRole('menu')
      expect(menus).toHaveLength(2)
      return menus[1]!
    })
    expect(within(cascade).getByRole('menuitem', { name: 'Checklist, cross out checked items' })).toBeInTheDocument()
  })
})
