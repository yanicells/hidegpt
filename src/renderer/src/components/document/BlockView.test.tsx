/** @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { BlockView } from './BlockView'

afterEach(cleanup)

describe('BlockView callout', () => {
  it('shows a step with no body as a plain row, with no arrow and nothing to open', () => {
    const { container } = render(
      <BlockView block={{ kind: 'callout', id: 'c1', title: 'Finished a step', body: '' }} streaming={false} />,
    )
    expect(screen.getByText('Finished a step')).toBeTruthy()
    expect(container.querySelector('details, .callout-arrow')).toBeNull()
  })

  it('keeps a step with a body collapsible', () => {
    const { container } = render(
      <BlockView block={{ kind: 'callout', id: 'c1', title: 'Ran a command', body: 'ls' }} streaming={false} />,
    )
    expect(container.querySelector('details .callout-arrow')).not.toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe('ls')
  })
})
