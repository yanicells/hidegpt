/** @vitest-environment jsdom */

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { stubModel, stubThread } from '../../codex/fake'
import { emptySnapshot, type Snapshot } from '../../codex/types'
import type { Command, HideGptApi, MenuAction } from '../../shared/api'
import { App } from './app'
import { groupByRecency } from './components/home/grouping'
import { projectFolders } from './components/home/ProjectFolders'

import '@testing-library/jest-dom/vitest'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
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
    pickDirectory: async () => '/tmp/project',
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
    expect(screen.getByText('Blank document')).toBeInTheDocument()
    expect(screen.getByTestId('template-essay')).toBeInTheDocument()
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
    expect(within(list as HTMLElement).getByText('Owned by')).toBeInTheDocument()
    expect(within(list as HTMLElement).getAllByText('me').length).toBeGreaterThan(0)
  })

  it('creates a document from the blank template', async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await user.click(screen.getByTestId('new-doc'))
    expect(calls.some((call) => call.op === 'newDocument')).toBe(false)
    expect(screen.getByRole('dialog')).toHaveTextContent('Location')
    await user.click(screen.getByRole('button', { name: 'Create document' }))
    expect(calls).toContainEqual({ op: 'newDocument', title: '', projectId: null, cwd: undefined })
  })
})

describe('document page', () => {
  it('renders questions at body scale with separators and an outline', () => {
    mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      blocks: [
        { kind: 'user', id: 'u1', text: 'What is photosynthesis?' },
        { kind: 'agent', id: 'a1', text: 'Plants turn light into food.' },
        { kind: 'user', id: 'u2', text: 'Why is it green?' },
        { kind: 'agent', id: 'a2', text: 'Chlorophyll.' },
      ],
    })
    const questions = document.querySelectorAll('.doc-question')
    expect(questions).toHaveLength(2)
    // Later questions are separated like document sections, not giant headings.
    expect(document.querySelectorAll('.doc-block.turn-start')).toHaveLength(1)
    expect(document.querySelector('.doc-heading')).toBeNull()
    const outline = screen.getByTestId('outline')
    expect(outline).toHaveTextContent('What is photosynthesis?')
    expect(screen.getByTestId('outline-u2')).toHaveTextContent('Why is it green?')
  })

  it('hides reasoning callouts and usage meters from the page', () => {
    mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      blocks: [
        { kind: 'user', id: 'u1', text: 'Hi' },
        { kind: 'agent', id: 'a1', text: 'Hello.' },
      ],
      rateLimits: {
        rateLimits: {
          limitId: 'codex',
          limitName: 'Codex',
          primary: { usedPercent: 88, windowDurationMins: 300, resetsAt: null },
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: 'plus',
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
        accountId: null,
        rateLimitUpsell: null,
      },
    })
    expect(screen.queryByText(/% used/)).toBeNull()
  })

  it('switches providers from the toolbar', async () => {
    const user = userEvent.setup()
    const { calls } = mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
    })
    await user.click(screen.getByTestId('chip-provider'))
    await user.click(screen.getByTestId('pick-opencode'))
    expect(calls).toContainEqual({ op: 'setProvider', provider: 'opencode' })
  })

  it('searches models and picks a speed from floating dropdowns', async () => {
    const user = userEvent.setup()
    const { calls } = mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      models: [
        {
          id: 'a',
          model: 'a',
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: 'AlphaGuide',
          description: '',
          modelSpecialty: null,
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: 'medium',
          inputModalities: [],
          supportsPersonality: true,
          multiAgentVersion: null,
          additionalSpeedTiers: [],
          serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }],
          defaultServiceTier: null,
          isDefault: true,
        },
      ],
      model: 'a',
    })
    await user.click(screen.getByTestId('chip-model'))
    const search = screen.getByTestId('menu-search')
    await user.type(search, 'alpha')
    expect(screen.getByTestId('pick-a')).toBeInTheDocument()
    await user.click(screen.getByTestId('chip-speed'))
    await user.click(screen.getByTestId('pick-fast'))
    expect(calls).toContainEqual({ op: 'setServiceTier', serviceTier: 'fast' })
  })

  it('walks document tabs like back, jump, and new', async () => {
    const user = userEvent.setup()
    const { calls } = mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      blocks: [
        { kind: 'user', id: 'u1', text: 'First question' },
        { kind: 'agent', id: 'a1', text: 'Answer.' },
      ],
    })
    expect(screen.getByTestId('outline')).toHaveTextContent('Document tabs')
    await user.click(screen.getByTestId('outline-u1'))
    await user.click(screen.getByLabelText('New document'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByLabelText('Back to documents'))
    expect(calls).toContainEqual({ op: 'goHome' })
  })
})

function docModels() {
  const alpha = { ...stubModel(), id: 'alpha', model: 'alpha', displayName: 'AlphaGuide', isDefault: true }
  const beta = { ...stubModel(), id: 'beta', model: 'beta', displayName: 'BetaHelper', isDefault: false }
  return [alpha, beta]
}

describe('toolbar dropdowns', () => {
  it('toggles the model menu open and closed', async () => {
    const user = userEvent.setup()
    mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      models: [stubModel()],
      model: 'gpt-5.6-sol',
    })
    expect(screen.queryByTestId('menu-search')).toBeNull()
    await user.click(screen.getByTestId('chip-model'))
    expect(screen.getByTestId('menu-search')).toBeInTheDocument()
    await user.click(screen.getByTestId('chip-model'))
    expect(screen.queryByTestId('menu-search')).toBeNull()
  })

  it('dispatches setModel and closes when picking a model', async () => {
    const user = userEvent.setup()
    const { calls } = mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      models: docModels(),
      model: 'alpha',
    })
    await user.click(screen.getByTestId('chip-model'))
    expect(screen.getByTestId('menu-search')).toBeInTheDocument()
    await user.click(screen.getByTestId('pick-beta'))
    expect(calls).toContainEqual({ op: 'setModel', model: 'beta' })
    expect(screen.queryByTestId('menu-search')).toBeNull()
  })

  it('filters models by search text', async () => {
    const user = userEvent.setup()
    mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      models: docModels(),
      model: 'alpha',
    })
    await user.click(screen.getByTestId('chip-model'))
    expect(screen.getByTestId('pick-alpha')).toBeInTheDocument()
    expect(screen.getByTestId('pick-beta')).toBeInTheDocument()
    await user.type(screen.getByTestId('menu-search'), 'alpha')
    expect(screen.getByTestId('pick-alpha')).toBeInTheDocument()
    expect(screen.queryByTestId('pick-beta')).toBeNull()
  })

  it('dispatches setServiceTier from the speed chip', async () => {
    const user = userEvent.setup()
    const { calls } = mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      models: [{ ...stubModel(), id: 'a', model: 'a', displayName: 'AlphaGuide', isDefault: true }],
      model: 'a',
    })
    await user.click(screen.getByTestId('chip-speed'))
    await user.click(screen.getByTestId('pick-fast'))
    expect(calls).toContainEqual({ op: 'setServiceTier', serviceTier: 'fast' })
  })
})

describe('document tabs active pill', () => {
  it('switches the active pill and tolerates double clicks', async () => {
    const user = userEvent.setup()
    mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      blocks: [
        { kind: 'user', id: 'u1', text: 'First question' },
        { kind: 'agent', id: 'a1', text: 'Answer one.' },
        { kind: 'user', id: 'u2', text: 'Second question' },
        { kind: 'agent', id: 'a2', text: 'Answer two.' },
      ],
    })
    // Latest question starts active.
    expect(screen.getByTestId('outline-u2')).toHaveClass('active')
    expect(screen.getByTestId('outline-u1')).not.toHaveClass('active')
    await user.click(screen.getByTestId('outline-u1'))
    expect(screen.getByTestId('outline-u1')).toHaveClass('active')
    expect(screen.getByTestId('outline-u2')).not.toHaveClass('active')
    // Second click on the same tab keeps working.
    await user.click(screen.getByTestId('outline-u1'))
    expect(screen.getByTestId('outline-u1')).toHaveClass('active')
    await user.click(screen.getByTestId('outline-u2'))
    expect(screen.getByTestId('outline-u2')).toHaveClass('active')
    expect(screen.getByTestId('outline-u1')).not.toHaveClass('active')
  })
})

function noonSec(offsetDays = 0): number {
  const now = new Date()
  const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0)
  return Math.floor((noon.getTime() - offsetDays * 86_400_000) / 1000)
}

describe('home list view', () => {
  it('groups loose documents by recency in list view', async () => {
    const user = userEvent.setup()
    mount({
      threads: [
        { ...stubThread('thr_today', 'Today doc', 'Today doc'), recencyAt: noonSec(0), updatedAt: noonSec(0) },
        { ...stubThread('thr_yest', 'Yesterday doc', 'Yesterday doc'), recencyAt: noonSec(1), updatedAt: noonSec(1) },
      ],
    })
    await user.click(screen.getByLabelText('List view'))
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('Yesterday')).toBeInTheDocument()
    expect(screen.getByTestId('thread-thr_today')).toBeInTheDocument()
    expect(screen.getByTestId('thread-thr_yest')).toBeInTheDocument()
  })

  it('renders project folders by name, not hash', () => {
    mount({
      threads: [stubThread('thr_p1', 'Proj doc', 'Proj doc', 'proj_1')],
      projects: [
        {
          id: 'proj_1',
          name: 'My Project',
          roots: [],
          metadata: {},
          position: 0,
          createdAt: 0,
          updatedAt: 0,
          recencyAt: null,
        },
      ],
    })
    expect(screen.getByTestId('project-proj_1')).toHaveTextContent('My Project')
    expect(screen.queryByText('proj_1')).toBeNull()
  })

  it('dispatches setSearch when typing in home search', async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await user.type(screen.getByTestId('home-search'), 'photo')
    expect(calls.some((call) => call.op === 'setSearch')).toBe(true)
    expect(calls).toContainEqual({ op: 'setSearch', value: 'p' })
  })
})

describe('grouping', () => {
  it('titles orphan folders by directory basename, never a hash', () => {
    const threads = [
      { ...stubThread('o1', 'doc1', 'Doc1', 'unknown-hash'), cwd: '/Users/yan/projects/myapp' },
      { ...stubThread('o2', 'doc2', 'Doc2', 'unknown-hash'), cwd: '/Users/yan/projects/myapp' },
    ]
    const snap = { ...emptySnapshot(), threads, projects: [], search: '' }
    const orphan = projectFolders(snap).find((folder) => folder.id === 'unknown-hash')
    expect(orphan).toBeTruthy()
    expect(orphan?.name).toBe('myapp')
    expect(orphan?.name).not.toBe('Folder')
    expect(orphan?.name).not.toContain('unknown-hash')
  })

  it('buckets ms timestamps correctly', () => {
    const now = new Date()
    const noonMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0).getTime()
    const threads = [
      { ...stubThread('m-today', 't', 'T'), recencyAt: noonMs, updatedAt: Math.floor(noonMs / 1000) },
      {
        ...stubThread('m-yest', 'y', 'Y'),
        recencyAt: noonMs - 86_400_000,
        updatedAt: Math.floor((noonMs - 86_400_000) / 1000),
      },
    ]
    const sections = groupByRecency(threads)
    expect(sections.find((section) => section.title === 'Today')?.threads.map((thread) => thread.id)).toContain(
      'm-today',
    )
    expect(sections.find((section) => section.title === 'Yesterday')?.threads.map((thread) => thread.id)).toContain(
      'm-yest',
    )
  })
})

const projectFixture = {
  id: 'course',
  name: 'Course notes',
  roots: [{ path: '/tmp/course' }],
  metadata: {},
  position: 0,
  createdAt: 0,
  updatedAt: 0,
  recencyAt: null,
}

describe('project navigation and creation', () => {
  it('opens empty projects, keeps layout controls, and preselects the destination', async () => {
    const user = userEvent.setup()
    const { calls } = mount({ projects: [projectFixture] })
    await user.click(screen.getByTestId('project-course'))
    expect(screen.getByRole('heading', { name: 'Course notes' })).toBeInTheDocument()
    expect(screen.queryByTestId('thread-thr_1')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'List view' }))
    await user.click(screen.getByRole('button', { name: 'New document' }))
    expect(screen.getByTestId('new-doc-location')).toHaveValue('course')
    await user.type(screen.getByLabelText('Document name'), 'Week 4')
    await user.click(screen.getByRole('button', { name: 'Create document' }))
    expect(calls).toContainEqual({ op: 'newDocument', title: 'Week 4', projectId: 'course', cwd: '/tmp/course' })
  })

  it('can leave a project and create an unfiled document explicitly', async () => {
    const user = userEvent.setup()
    const { calls } = mount({ projects: [projectFixture] })
    await user.click(screen.getByTestId('project-course'))
    await user.click(screen.getByRole('button', { name: 'New document' }))
    await user.selectOptions(screen.getByTestId('new-doc-location'), '')
    await user.click(screen.getByRole('button', { name: 'Create document' }))
    expect(calls).toContainEqual({ op: 'newDocument', title: '', projectId: null, cwd: undefined })
  })

  it('cancels creation without making a provider thread', async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await user.click(screen.getByTestId('template-essay'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.some((call) => call.op === 'newDocument')).toBe(false)
  })

  it('gives immediate opening feedback and permits cancellation', async () => {
    const user = userEvent.setup()
    const { calls } = mount({ openingThreadId: 'thr_1' })
    expect(screen.getByTestId('opening-document')).toHaveTextContent('Opening Photosynthesis')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(calls).toContainEqual({ op: 'goHome' })
  })
})
