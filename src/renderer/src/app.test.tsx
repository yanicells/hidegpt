/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Command, HideGptApi, MenuAction, SnapshotPatch } from '../../shared/api'
import { CAPABILITIES, emptySnapshot, type DocSummary, type ModelOption, type Snapshot } from '../../shared/model'
import { App } from './app'
import { clearCommandError } from './session-bridge'
import { groupByRecency } from './components/home/grouping'
import { projectFolders, threadProjectId } from './components/home/projects'
import { takePendingDraft } from './templates'

import '@testing-library/jest-dom/vitest'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  clearCommandError()
  // A template's starter text waits for the next composer; don't leak it across tests.
  takePendingDraft()
})

function stubThread(id: string, preview: string, name?: string, projectId: string | null = null): DocSummary {
  return { id, name: name ?? null, preview, updatedAt: 1_700_000_000, cwd: '/tmp', projectId }
}

function stubModel(id = 'gpt-5.6-sol', label = 'GPT-5.6 Sol', isDefault = true): ModelOption {
  return { id, label, efforts: [], defaultEffort: null, serviceTiers: [{ id: 'fast', name: 'Fast' }], isDefault }
}

/** Renders the app over a stub bridge; `fail` turns a command into a rejection with that message. */
function mount(partial: Partial<Snapshot> = {}, fail: (command: Command) => string | null = () => null) {
  const calls: Command[] = []
  const menuHandlers = new Set<(action: MenuAction) => void>()
  const listeners = new Set<(patch: SnapshotPatch) => void>()
  let snapshot: Snapshot = {
    ...emptySnapshot(),
    status: 'ready',
    account: { kind: 'chatgpt', label: 'yan@school.edu' },
    threads: [
      stubThread('thr_1', 'Essay on photosynthesis', 'Photosynthesis'),
      stubThread('thr_2', 'Lab notes', 'Chem lab'),
    ],
    ...partial,
  }

  let seq = 0
  const api: HideGptApi = {
    getSnapshot: () => ({ snapshot, seq }),
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
      const failure = fail(command)
      if (failure) return { ok: false, error: failure }
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
      if (command.op === 'resolveApproval') {
        const resolved = command.accept ? 'accepted' : 'skipped'
        snapshot = {
          ...snapshot,
          blocks: snapshot.blocks.map((block) =>
            block.kind === 'approval' && block.id === command.blockId ? { ...block, resolved } : block,
          ),
        }
      }
      if (command.op === 'goHome') {
        snapshot = { ...snapshot, route: { kind: 'home' }, title: 'Docs' }
      }
      seq += 1
      for (const listener of listeners) listener({ fields: snapshot, seq })
      return { ok: true }
    },
    pickDirectory: async () => '/tmp/project',
    // GIFs stand in for a picture main could not store.
    saveImage: async ({ mime }) =>
      mime === 'image/gif'
        ? { ok: false, error: 'Docs could not save that image. Check your disk space.' }
        : { ok: true, path: `/tmp/pasted.${mime.split('/')[1]}` },
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
    expect(screen.getByTestId('composer')).toHaveAttribute('placeholder', 'Type @ to insert')
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
    expect(await screen.findByTestId('panel-file')).toHaveTextContent('New')
    expect(screen.getByTestId('panel-file')).toHaveTextContent('Open')
  })

  it('creates a document from File > New > Document', async () => {
    const user = userEvent.setup()
    const { calls } = mount({ route: { kind: 'doc', threadId: 'thr_1' }, title: 'Photosynthesis' })
    await user.click(screen.getByTestId('menu-file'))
    await user.click(await screen.findByTestId('action-new'))
    // The submenu ignores pointer events until it finishes opening, so click it directly.
    fireEvent.click(await screen.findByTestId('action-new-document'))
    // Strict: main's schema rejects a cwd key holding undefined, so it must be absent.
    expect(calls.find((call) => call.op === 'newDocument')).toStrictEqual({ op: 'newDocument', projectId: null })
  })

  it('shows a pending approval as a Docs suggestion card', async () => {
    const user = userEvent.setup()
    const approval = {
      kind: 'approval' as const,
      id: 'approval-1',
      suggestion: 'add' as const,
      title: 'Run command?',
      body: 'npm test',
      fields: [],
      questions: [],
      resolved: null,
    }
    const { calls } = mount({ route: { kind: 'doc', threadId: 'thr_1' }, blocks: [approval] })
    const card = screen.getByTestId('approval-approval-1')
    expect(card).toHaveTextContent('Add: “npm test”')
    expect(card).toHaveTextContent('Yan')
    expect(card).not.toHaveTextContent('Run command')
    await user.click(screen.getByRole('button', { name: 'Accept suggestion' }))
    expect(calls).toContainEqual({
      op: 'resolveApproval',
      provider: 'codex',
      threadId: 'thr_1',
      blockId: 'approval-1',
      accept: true,
      answers: {},
    })
  })

  it('shows a search field on the homepage', () => {
    mount()
    expect(screen.getByTestId('home-search')).toHaveAttribute('placeholder', 'Search')
  })

  it('can switch recent documents to a list with owners', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByLabelText('List view'))
    expect(screen.getByText('Last opened by me')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Documents' })
    expect(within(list).getAllByText('me').length).toBeGreaterThan(0)
    // One toggle, like Docs: in list view it offers the grid.
    expect(screen.queryByLabelText('List view')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Grid view')).toBeInTheDocument()
  })

  it('creates a document from the blank template', async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    // Like Docs, Blank document creates right away with no naming step.
    await user.click(screen.getByTestId('new-doc'))
    expect(screen.queryByRole('dialog')).toBeNull()
    // Strict: main's schema rejects a cwd key holding undefined, so it must be absent.
    expect(calls.find((call) => call.op === 'newDocument')).toStrictEqual({ op: 'newDocument', projectId: null })
  })
})

describe('document page', () => {
  it('offers older turns only once the document has finished opening', async () => {
    const blocks = Array.from({ length: 30 }, (_, i) => ({ kind: 'user' as const, id: `u${i}`, text: `Question ${i}` }))
    mount({ route: { kind: 'doc', threadId: 'thr_1' }, title: 'Photosynthesis', blocks, hasOlder: true })
    // The first row anchors your place, so it must be on the page when the older turns arrive.
    expect(screen.getByTestId('load-older')).toBeDisabled()
    await waitFor(() => expect(screen.getByTestId('load-older')).toBeEnabled())
  })

  it('renders questions as Heading 1 sections with an outline', () => {
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
    const questions = screen.getAllByRole('heading', { level: 1 })
    expect(questions.map((heading) => heading.textContent)).toEqual(['What is photosynthesis?', 'Why is it green?'])
    // Docs has no turn separators; headings alone structure the page.
    expect(document.querySelector('.turn-start')).toBeNull()
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
    })
    expect(screen.queryByText(/% used/)).toBeNull()
  })

  it('switches providers from the account menu', async () => {
    const user = userEvent.setup()
    const { calls } = mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
    })
    // Provider names stay hidden until the avatar menu opens.
    expect(screen.queryByText('OpenCode')).toBeNull()
    await user.click(screen.getByTestId('menu-account'))
    await user.click(await screen.findByTestId('library-opencode'))
    expect(calls).toContainEqual({ op: 'setProvider', provider: 'opencode', home: false })
  })

  it('picks a model from a style cascade and a speed from floating dropdowns', async () => {
    const user = userEvent.setup()
    const { calls } = mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      models: [stubModel('a', 'AlphaGuide')],
      model: 'a',
    })
    await user.click(screen.getByTestId('chip-model'))
    await user.hover(await screen.findByTestId('pick-a'))
    // Submenus ignore pointer events until they finish opening.
    fireEvent.click(await screen.findByTestId('pick-apply-0'))
    expect(calls).toContainEqual({ op: 'setModel', model: 'a' })
    await user.click(screen.getByTestId('chip-speed'))
    await user.click(await screen.findByTestId('pick-fast'))
    expect(calls).toContainEqual({ op: 'setServiceTier', serviceTier: 'fast' })
  })

  it('walks document tabs: jump, new, collapse, and home', async () => {
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
    await user.click(screen.getByLabelText('Add tab'))
    // Strict: main's schema rejects a cwd key holding undefined, so it must be absent.
    expect(calls.find((call) => call.op === 'newDocument')).toStrictEqual({ op: 'newDocument', projectId: null })
    await user.click(screen.getByLabelText('Hide tabs & outlines'))
    expect(screen.queryByTestId('outline-u1')).toBeNull()
    await user.click(screen.getByLabelText('Show tabs & outlines'))
    expect(screen.getByTestId('outline-u1')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Docs home'))
    expect(calls).toContainEqual({ op: 'goHome' })
  })
})

function docModels() {
  return [stubModel('alpha', 'AlphaGuide'), stubModel('beta', 'BetaHelper', false)]
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
    expect(screen.queryByTestId('pick-options')).toBeNull()
    await user.click(screen.getByTestId('chip-model'))
    expect(await screen.findByTestId('pick-options')).toBeInTheDocument()
    await user.click(screen.getByTestId('chip-model'))
    await waitFor(() => expect(screen.queryByTestId('pick-options')).toBeNull())
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
    // The second model sits in the second style slot.
    expect(await screen.findByTestId('pick-beta')).toHaveTextContent('Title')
    await user.click(screen.getByTestId('pick-beta'))
    expect(calls).toContainEqual({ op: 'setModel', model: 'beta' })
    await waitFor(() => expect(screen.queryByTestId('pick-options')).toBeNull())
  })

  it('keeps model names out of the style menu text', async () => {
    const user = userEvent.setup()
    mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      models: docModels(),
      model: 'alpha',
    })
    await user.click(screen.getByTestId('chip-model'))
    // Slots show style names; the real name is only the row's tooltip.
    expect(await screen.findByTestId('pick-alpha')).toHaveTextContent('Normal text')
    expect(screen.queryByText('AlphaGuide')).toBeNull()
    await user.hover(screen.getByTestId('pick-alpha'))
    expect(await screen.findByText('AlphaGuide', {}, { timeout: 2000 })).toHaveClass('tooltip')
    await user.unhover(screen.getByTestId('pick-alpha'))
    await user.click(screen.getByTestId('pick-options'))
    expect(await screen.findByTestId('pick-reset-styles')).toHaveTextContent('Reset styles')
    expect(screen.queryByText('BetaHelper')).toBeNull()
  })

  it('dispatches setServiceTier from the speed chip', async () => {
    const user = userEvent.setup()
    const { calls } = mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      models: [stubModel('a', 'AlphaGuide')],
      model: 'a',
    })
    await user.click(screen.getByTestId('chip-speed'))
    await user.click(await screen.findByTestId('pick-fast'))
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
        { ...stubThread('thr_today', 'Today doc', 'Today doc'), updatedAt: noonSec(0) },
        { ...stubThread('thr_yest', 'Yesterday doc', 'Yesterday doc'), updatedAt: noonSec(1) },
      ],
    })
    await user.click(screen.getByLabelText('List view'))
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('Yesterday')).toBeInTheDocument()
    expect(screen.getByTestId('thread-thr_today')).toBeInTheDocument()
    expect(screen.getByTestId('thread-thr_yest')).toBeInTheDocument()
  })

  it('renders project folders by name, not hash', async () => {
    mount({
      threads: [stubThread('thr_p1', 'Proj doc', 'Proj doc', 'proj_1')],
      projects: [{ id: 'proj_1', name: 'My Project', roots: [] }],
    })
    await userEvent.click(screen.getByTestId('open-picker'))
    expect(await screen.findByTestId('picker-proj_1')).toHaveTextContent('My Project')
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

  it('buckets documents by the day they were last updated', () => {
    const threads = [
      { ...stubThread('m-today', 't', 'T'), updatedAt: noonSec(0) },
      { ...stubThread('m-yest', 'y', 'Y'), updatedAt: noonSec(1) },
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

const projectFixture = { id: 'course', name: 'Course notes', roots: [{ path: '/tmp/course' }] }

describe('project navigation and creation', () => {
  it('filters by folder and creates new documents inside it', async () => {
    const user = userEvent.setup()
    const { calls } = mount({ projects: [projectFixture] })
    await user.click(screen.getByTestId('open-picker'))
    // A click only selects, as in Google Picker; Select opens it.
    expect(screen.getByTestId('picker-select')).toBeDisabled()
    await user.click(await screen.findByTestId('picker-course'))
    await user.click(screen.getByTestId('picker-select'))
    expect(screen.getByTestId('recent-title')).toHaveTextContent('Course notes')
    expect(screen.queryByTestId('thread-thr_1')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'List view' }))
    await user.click(screen.getByTestId('new-doc'))
    expect(calls).toContainEqual({ op: 'newDocument', projectId: 'course', cwd: '/tmp/course' })
  })

  it('leaves a folder through Owned by anyone, creating unfiled documents again', async () => {
    const user = userEvent.setup()
    const { calls } = mount({ projects: [projectFixture] })
    await user.click(screen.getByTestId('open-picker'))
    await user.dblClick(await screen.findByTestId('picker-course'))
    await user.click(screen.getByTestId('home-location'))
    await user.click(await screen.findByTestId('owner-anyone'))
    expect(screen.getByTestId('recent-title')).toHaveTextContent('Recent documents')
    await user.click(screen.getByTestId('template-essay'))
    // Strict: main's schema rejects a cwd key holding undefined, so it must be absent.
    expect(calls.find((call) => call.op === 'newDocument')).toStrictEqual({ op: 'newDocument', projectId: null })
  })

  it('files a document made from inside a folder document in that folder', async () => {
    const user = userEvent.setup()
    const inFolder = { ...stubThread('thr_c', 'Week 3 notes', 'Week 3'), cwd: '/tmp/course/week3' }
    const { calls } = mount({
      projects: [projectFixture],
      threads: [inFolder],
      route: { kind: 'doc', threadId: 'thr_c' },
      title: 'Week 3',
    })
    await user.click(screen.getByLabelText('Add tab'))
    expect(calls).toContainEqual({ op: 'newDocument', projectId: 'course', cwd: '/tmp/course' })
  })

  it('searches folders in the file picker', async () => {
    const user = userEvent.setup()
    mount({ projects: [projectFixture] })
    await user.click(screen.getByTestId('open-picker'))
    await user.type(await screen.findByLabelText('Search in Drive'), 'zzz')
    expect(screen.queryByTestId('picker-course')).toBeNull()
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('opens folders and adds new ones from the file picker', async () => {
    const user = userEvent.setup()
    const { calls } = mount({ projects: [projectFixture] })
    await user.click(screen.getByTestId('open-picker'))
    expect(await screen.findByRole('dialog')).toHaveTextContent('Open a file')
    await user.click(screen.getByTestId('new-folder'))
    expect(screen.getByLabelText('Folder name')).toHaveValue('Untitled folder')
    await user.clear(screen.getByLabelText('Folder name'))
    await user.type(screen.getByLabelText('Folder name'), 'Week 4')
    await user.click(await screen.findByRole('button', { name: 'Create' }))
    expect(calls).toContainEqual({ op: 'createProject', name: 'Week 4', cwd: '/tmp/project' })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.dblClick(await screen.findByTestId('picker-course'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('recent-title')).toHaveTextContent('Course notes')
  })

  it('gives immediate opening feedback and permits cancellation', async () => {
    const user = userEvent.setup()
    const { calls } = mount({ openingThreadId: 'thr_1' })
    expect(screen.getByTestId('opening-document')).toHaveTextContent('Opening Photosynthesis')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(calls).toContainEqual({ op: 'goHome' })
  })
})

describe('library and reading preferences', () => {
  it('switches libraries from home', async () => {
    const { calls } = mount()
    await userEvent.click(screen.getByTestId('menu-account'))
    await userEvent.click(await screen.findByTestId('library-opencode'))
    expect(calls).toContainEqual({ op: 'setProvider', provider: 'opencode', home: true })
  })

  it('hides tool activity by default and shows it as non-printing characters', async () => {
    mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      blocks: [
        { kind: 'user', id: 'u', text: 'Question' },
        { kind: 'agent', id: 'progress', text: 'Checking files', commentary: true },
        { kind: 'callout', id: 'tool', title: 'Ran a command', body: 'ls' },
        { kind: 'agent', id: 'answer', text: 'The final answer' },
      ],
    })
    expect(screen.queryByText('Checking files')).toBeNull()
    expect(screen.queryByText('Ran a command')).toBeNull()
    expect(screen.getByText('The final answer')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('menu-view'))
    await userEvent.click(await screen.findByText('Show non-printing characters'))
    expect(screen.getByText('Checking files')).toBeInTheDocument()
    expect(screen.getByText('Ran a command')).toBeInTheDocument()
    expect(localStorage.getItem('hidegpt-output-only')).toBe('false')
  })

  it('files legacy documents under their folder and includes descendants', async () => {
    const legacy = {
      ...stubThread('legacy', 'Legacy document', 'Legacy document'),
      cwd: '/tmp/course/notes',
      projectId: null,
    }
    const outside = { ...stubThread('outside', 'Outside', 'Outside'), cwd: '/tmp/coursework', projectId: null }
    mount({ projects: [projectFixture], threads: [legacy, outside] })
    await userEvent.click(screen.getByTestId('open-picker'))
    await userEvent.dblClick(await screen.findByTestId('picker-course'))
    expect(screen.getByTestId('thread-legacy')).toBeInTheDocument()
    expect(screen.queryByTestId('thread-outside')).toBeNull()
  })
})

it('prefers the deepest folder root and keeps explicit assignments authoritative', () => {
  const snap = {
    ...emptySnapshot(),
    projects: [projectFixture, { ...projectFixture, id: 'nested', roots: [{ path: '/tmp/course/notes/' }] }],
  }
  const thread = { ...stubThread('legacy', '', ''), cwd: '/tmp/course/notes/week-1/', projectId: null }
  expect(threadProjectId(snap, thread)).toBe('nested')
  expect(threadProjectId(snap, { ...thread, projectId: 'course' })).toBe('course')
  expect(threadProjectId(snap, { ...thread, cwd: '/tmp/coursework' })).toBeNull()
})

describe('composer attachments', () => {
  const skills = [
    { name: 'humanizer', description: 'Rewrite text so it reads naturally', path: '/s/humanizer/SKILL.md' },
    { name: 'study-guide', description: 'Turn notes into a study guide', path: '/s/study-guide/SKILL.md' },
  ]

  it('inserts a skill chip from the @ menu and sends it with the question', async () => {
    const user = userEvent.setup()
    const { calls } = mount({ route: { kind: 'doc', threadId: 'thr_1' }, title: 'Photosynthesis', skills })
    const composer = screen.getByTestId('composer')
    await user.type(composer, 'Please @hum')
    expect(screen.getByTestId('skill-menu')).toHaveTextContent('humanizer')
    expect(screen.queryByTestId('skill-study-guide')).not.toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(screen.queryByTestId('skill-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('chip-skill-humanizer')).toBeInTheDocument()
    await user.type(composer, 'fix this{Enter}')
    expect(calls.at(-1)).toEqual({
      op: 'send',
      provider: 'codex',
      threadId: 'thr_1',
      text: 'Please fix this',
      skill: 'humanizer',
    })
  })

  it('attaches pasted images and sends them without text', async () => {
    const { calls } = mount({ route: { kind: 'doc', threadId: 'thr_1' }, title: 'Photosynthesis' })
    const composer = screen.getByTestId('composer')
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    fireEvent.paste(composer, { clipboardData: { files: [file] } })
    expect(await screen.findByTestId('composer-images')).toBeInTheDocument()
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(calls.at(-1)).toEqual({
      op: 'send',
      provider: 'codex',
      threadId: 'thr_1',
      text: '',
      images: ['/tmp/pasted.png'],
    })
  })

  it('attaches the pictures that saved and puts the first failure on the banner', async () => {
    mount({ route: { kind: 'doc', threadId: 'thr_1' }, title: 'Photosynthesis' })
    const composer = screen.getByTestId('composer')
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const gif = new File([new Uint8Array([2])], 'b.gif', { type: 'image/gif' })
    fireEvent.paste(composer, { clipboardData: { files: [png, gif] } })
    expect(await screen.findByTestId('error-banner')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Docs could not save that image. Check your disk space.')).toBeInTheDocument()
    expect(screen.getByTestId('composer-images').querySelectorAll('img')).toHaveLength(1)
  })

  it('shows images and skills on sent questions', () => {
    mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      title: 'Photosynthesis',
      blocks: [{ kind: 'user', id: 'u1', text: 'What is this?', images: ['/tmp/a.png'], skills: ['humanizer'] }],
    })
    const image = screen.getByTestId('document').querySelector('.doc-question')?.previousElementSibling
    expect(image?.querySelector('img')).toHaveAttribute('src', 'docs://local/%2Ftmp%2Fa.png')
    expect(screen.getByTestId('chip-skill-humanizer')).toBeInTheDocument()
  })
})

describe('failures and replies', () => {
  const doc = { route: { kind: 'doc', threadId: 'thr_1' }, title: 'Photosynthesis' } as const

  it('keeps the draft when a question is not accepted, and says why', async () => {
    const user = userEvent.setup()
    mount(doc, (command) => (command.op === 'send' ? 'Wait for the current answer to finish.' : null))
    await user.type(screen.getByTestId('composer'), 'Why is it green?{Enter}')
    expect(await screen.findByTestId('error-banner')).toHaveTextContent('Something went wrong. Try again.')
    await user.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Wait for the current answer to finish.')).toBeInTheDocument()
    expect(screen.getByTestId('composer')).toHaveValue('Why is it green?')
  })

  it('shows a library error as a banner without hiding the page', async () => {
    const user = userEvent.setup()
    const { calls } = mount({ status: 'error', error: 'Docs couldn’t reach this library.' })
    expect(screen.getByTestId('error-banner')).toHaveTextContent('Something went wrong. Try again.')
    expect(screen.queryByText('Docs couldn’t reach this library.')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Docs couldn’t reach this library.')).toBeInTheDocument()
    expect(screen.getByTestId('thread-thr_1')).toBeInTheDocument()
    await user.click(screen.getByTestId('error-refresh'))
    expect(calls).toContainEqual({ op: 'refresh' })
    await user.click(screen.getByTestId('error-dismiss'))
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  it('renames the document whose title was being edited, even if another one opened before the blur', async () => {
    const { calls } = mount(doc)
    const title = screen.getByLabelText('Document title')
    fireEvent.focus(title)
    fireEvent.change(title, { target: { value: 'Photosynthesis notes' } })
    // A navigation from elsewhere (a menu, Home in another window) lands while the field still has focus.
    await window.hidegpt!.dispatch({ op: 'openThread', threadId: 'thr_2' })
    fireEvent.blur(title)
    expect(calls.filter((command) => command.op === 'setDocumentName')).toEqual([
      { op: 'setDocumentName', provider: 'codex', threadId: 'thr_1', name: 'Photosynthesis notes' },
    ])
  })

  it('drafts approval answers locally and sends them once', async () => {
    const user = userEvent.setup()
    const { calls } = mount({
      ...doc,
      blocks: [
        {
          kind: 'approval',
          id: 'ap1',
          suggestion: 'question',
          title: 'Fill in the details',
          body: '',
          fields: [{ id: 'name', label: 'Name', initial: 'Yan' }],
          questions: [{ id: 'size', question: 'Which size?', options: ['Small', 'Large'], allowText: false }],
          resolved: null,
        },
      ],
    })
    await user.type(screen.getByTestId('draft-ap1-name'), 'i')
    await user.click(screen.getByRole('radio', { name: 'Large' }))
    expect(calls).toEqual([])
    await user.click(screen.getByTestId('accept-ap1'))
    expect(calls).toEqual([
      {
        op: 'resolveApproval',
        provider: 'codex',
        threadId: 'thr_1',
        blockId: 'ap1',
        accept: true,
        answers: { name: 'Yani', size: 'Large' },
      },
    ])
  })

  it('offers sign-in only to libraries that sign in inside Docs', async () => {
    const user = userEvent.setup()
    mount({
      provider: 'claude',
      capabilities: CAPABILITIES.claude,
      account: { kind: 'local', label: 'yan@school.edu' },
    })
    await user.click(screen.getByTestId('menu-account'))
    expect(screen.queryByTestId('action-login')).toBeNull()
    expect(screen.queryByTestId('action-logout')).toBeNull()
    cleanup()
    const { calls } = mount({ account: null })
    await user.click(screen.getByTestId('menu-account'))
    await user.click(screen.getByTestId('action-login'))
    expect(calls).toContainEqual({ op: 'login' })
  })
})
