/** @vitest-environment jsdom */

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { stubThread } from '../../codex/fake'
import { emptySnapshot, type Snapshot } from '../../codex/types'
import type { Command, HideGptApi, MenuAction } from '../../shared/api'
import { App } from './app'

import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
})

function mount(partial: Partial<Snapshot> = {}) {
  const calls: Command[] = []
  const menuHandlers = new Set<(action: MenuAction) => void>()
  const listeners = new Set<(snapshot: Snapshot) => void>()
  let snapshot: Snapshot = {
    ...emptySnapshot(),
    status: 'ready',
    account: { type: 'chatgpt', email: 'yan@school.edu', planType: 'plus' },
    threads: [
      stubThread('thr_1', 'Essay on photosynthesis', 'Photosynthesis'),
      stubThread('thr_2', 'Lab notes', 'Chem lab'),
    ],
    ...partial,
  }

  const api: HideGptApi = {
    getSnapshot: () => snapshot,
    onSnapshot: (handler) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    onMenu: (handler) => {
      menuHandlers.add(handler)
      return () => menuHandlers.delete(handler)
    },
    dispatch: async (command) => {
      calls.push(command)
      if (command.op === 'setSearch') {
        snapshot = { ...snapshot, search: command.value }
      }
      if (command.op === 'openThread') {
        const thread = snapshot.threads.find((item) => item.id === command.threadId)
        snapshot = {
          ...snapshot,
          route: { kind: 'doc', threadId: command.threadId },
          title: thread?.name ?? 'Untitled document',
        }
      }
      if (command.op === 'goHome') {
        snapshot = { ...snapshot, route: { kind: 'home' }, title: 'Docs' }
      }
      for (const listener of listeners) listener(snapshot)
    },
    platform: 'darwin',
  }
  window.hidegpt = api
  render(<App />)
  return { calls, emitMenu: (action: MenuAction) => menuHandlers.forEach((handler) => handler(action)) }
}

describe('docs home', () => {
  it('paints the Docs chrome and recent threads', () => {
    mount()
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.getByTestId('docs-home')).toHaveTextContent('Start a new document')
    expect(screen.getByText('Blank')).toBeInTheDocument()
    expect(screen.getByText('Recent documents')).toBeInTheDocument()
    expect(screen.getByTestId('thread-thr_1')).toHaveTextContent('Photosynthesis')
    expect(screen.getByTestId('thread-thr_2')).toHaveTextContent('Chem lab')
  })

  it('opens a thread as a document', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByTestId('thread-thr_1'))
    expect(screen.getByTestId('composer')).toHaveAttribute('placeholder', 'Type a question')
    expect(screen.getByDisplayValue('Photosynthesis')).toBeInTheDocument()
    expect(screen.getByTestId('menu-file')).toBeInTheDocument()
  })

  it('opens the File menu', async () => {
    const user = userEvent.setup()
    mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
    })
    await user.click(screen.getByTestId('menu-file'))
    expect(screen.getByTestId('panel-file')).toHaveTextContent('New document')
    expect(screen.getByTestId('panel-file')).toHaveTextContent('Open folder…')
  })

  it('shows a search field on the homepage', () => {
    mount()
    expect(screen.getByTestId('home-search')).toHaveAttribute('placeholder', 'Search documents')
  })

  it('can switch recent documents to a list with owners', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByLabelText('List view'))
    const list = screen.getByText('Name').closest('.list')
    expect(list).toBeTruthy()
    expect(within(list as HTMLElement).getByText('Owner')).toBeInTheDocument()
    expect(within(list as HTMLElement).getAllByText('yan@school.edu').length).toBeGreaterThan(0)
  })

  it('creates a document from the blank template', async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await user.click(screen.getByTestId('new-doc'))
    expect(calls.some((call) => call.op === 'newDocument')).toBe(true)
  })
})
