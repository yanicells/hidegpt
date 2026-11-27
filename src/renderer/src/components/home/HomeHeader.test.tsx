/** @vitest-environment jsdom */

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { emptySnapshot } from '../../../../shared/model'
import { HomeHeader } from './HomeHeader'

import '@testing-library/jest-dom/vitest'

afterEach(cleanup)

describe('HomeHeader', () => {
  it('quick-launches the four products in a new window, which main opens in the browser', () => {
    render(<HomeHeader snap={emptySnapshot()} />)
    const pill = screen.getByRole('navigation', { name: 'Google apps' })
    const links = within(pill).getAllByRole('link')
    expect(links.map((link) => [link.getAttribute('aria-label'), link.getAttribute('href')])).toEqual([
      ['Sheets', 'https://docs.google.com/spreadsheets/'],
      ['Slides', 'https://docs.google.com/presentation/'],
      ['Vids', 'https://docs.google.com/videos/'],
      ['Forms', 'https://docs.google.com/forms/'],
    ])
    for (const link of links) expect(link).toHaveAttribute('target', '_blank')
  })
})
