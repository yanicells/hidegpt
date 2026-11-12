/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Command, HideGptApi, MenuAction, SnapshotPatch } from '../../shared/api'
import { CAPABILITIES, emptySnapshot, type DocSummary, type ModelOption, type Snapshot } from '../../shared/model'
import { App } from './app'
import { clearCommandError } from './session-bridge'
import { groupByRecency } from './components/home/grouping'
import { projectFolders, threadProjectId } from './components/home/ProjectFolders'

import '@testing-library/jest-dom/vitest'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  clearCommandError()
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
    await user.click(screen.getByTestId('new-doc'))
    expect(calls.some((call) => call.op === 'newDocument')).toBe(false)
    expect(screen.getByRole('dialog')).toHaveTextContent('Location')
    await user.click(screen.getByRole('button', { name: 'Create document' }))
    expect(calls).toContainEqual({ op: 'newDocument', title: '', projectId: null, cwd: undefined })
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
      models: [stubModel('a', 'AlphaGuide')],
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
      models: [stubModel('a', 'AlphaGuide')],
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

  it('renders project folders by name, not hash', () => {
    mount({
      threads: [stubThread('thr_p1', 'Proj doc', 'Proj doc', 'proj_1')],
      projects: [{ id: 'proj_1', name: 'My Project', roots: [] }],
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

describe('library and reading preferences', () => {
  it('switches libraries from home', async () => {
    const { calls } = mount()
    await userEvent.click(screen.getByTestId('library-opencode'))
    expect(calls).toContainEqual({ op: 'setProvider', provider: 'opencode', home: true })
  })

  it('keeps the model picker open while its contents scroll', async () => {
    mount({ route: { kind: 'doc', threadId: 'thr_1' }, models: [stubModel()] })
    await userEvent.click(screen.getByTestId('chip-model'))
    const search = screen.getByPlaceholderText('Search models')
    fireEvent.scroll(search.parentElement!)
    expect(screen.getByPlaceholderText('Search models')).toBeInTheDocument()
    fireEvent.scroll(window)
    expect(screen.queryByPlaceholderText('Search models')).toBeNull()
  })

  it('persists output-only and keeps answers visible', async () => {
    mount({
      route: { kind: 'doc', threadId: 'thr_1' },
      blocks: [
        { kind: 'user', id: 'u', text: 'Question' },
        { kind: 'agent', id: 'progress', text: 'Checking files', commentary: true },
        { kind: 'callout', id: 'tool', title: 'Ran a command', body: 'ls' },
        { kind: 'agent', id: 'answer', text: 'The final answer' },
      ],
    })
    await userEvent.click(screen.getByTestId('menu-view'))
    await userEvent.click(screen.getByText('Output only'))
    expect(screen.queryByText('Checking files')).toBeNull()
    expect(screen.queryByText('Ran a command')).toBeNull()
    expect(screen.getByText('The final answer')).toBeInTheDocument()
    expect(localStorage.getItem('hidegpt-output-only')).toBe('true')
  })

  it('files legacy documents under their folder and includes descendants', async () => {
    const legacy = {
      ...stubThread('legacy', 'Legacy document', 'Legacy document'),
      cwd: '/tmp/course/notes',
      projectId: null,
    }
    const outside = { ...stubThread('outside', 'Outside', 'Outside'), cwd: '/tmp/coursework', projectId: null }
    mount({ projects: [projectFixture], threads: [legacy, outside] })
    expect(screen.getByTestId('project-course')).toHaveTextContent('1 document')
    await userEvent.click(screen.getByTestId('project-course'))
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
    expect(calls.at(-1)).toEqual({ op: 'send', text: 'Please fix this', skill: 'humanizer' })
  })

  it('attaches pasted images and sends them without text', async () => {
    const { calls } = mount({ route: { kind: 'doc', threadId: 'thr_1' }, title: 'Photosynthesis' })
    const composer = screen.getByTestId('composer')
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    fireEvent.paste(composer, { clipboardData: { files: [file] } })
    expect(await screen.findByTestId('composer-images')).toBeInTheDocument()
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(calls.at(-1)).toEqual({ op: 'send', text: '', images: ['/tmp/pasted.png'] })
  })

  it('attaches the pictures that saved and puts the first failure on the banner', async () => {
    mount({ route: { kind: 'doc', threadId: 'thr_1' }, title: 'Photosynthesis' })
    const composer = screen.getByTestId('composer')
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const gif = new File([new Uint8Array([2])], 'b.gif', { type: 'image/gif' })
    fireEvent.paste(composer, { clipboardData: { files: [png, gif] } })
    expect(await screen.findByTestId('error-banner')).toHaveTextContent('Docs could not save that image.')
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
    expect(await screen.findByTestId('error-banner')).toHaveTextContent('Wait for the current answer to finish.')
    expect(screen.getByTestId('composer')).toHaveValue('Why is it green?')
  })

  it('shows a library error as a banner without hiding the page', async () => {
    const user = userEvent.setup()
    const { calls } = mount({ status: 'error', error: 'Docs couldn’t reach this library.' })
    expect(screen.getByTestId('error-banner')).toHaveTextContent('Docs couldn’t reach this library.')
    expect(screen.getByTestId('thread-thr_1')).toBeInTheDocument()
    await user.click(screen.getByTestId('error-refresh'))
    expect(calls).toContainEqual({ op: 'refresh' })
    await user.click(screen.getByTestId('error-dismiss'))
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  it('drafts approval answers locally and sends them once', async () => {
    const user = userEvent.setup()
    const { calls } = mount({
      ...doc,
      blocks: [
        {
          kind: 'approval',
          id: 'ap1',
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
    expect(await screen.findByText('Accepted')).toBeInTheDocument()
    expect(calls).toEqual([{ op: 'resolveApproval', blockId: 'ap1', accept: true, answers: { name: 'Yani', size: 'Large' } }])
  })

  it('offers Log in only to libraries that sign in inside Docs', async () => {
    const user = userEvent.setup()
    mount({ provider: 'claude', capabilities: CAPABILITIES.claude, account: { kind: 'local', label: 'yan@school.edu' } })
    await user.click(screen.getByTestId('menu-account'))
    expect(screen.getByTestId('panel-account')).not.toHaveTextContent(/Log (in|out)/)
    cleanup()
    mount({ account: null })
    await user.click(screen.getByTestId('menu-account'))
    expect(screen.getByTestId('panel-account')).toHaveTextContent('Log in with ChatGPT')
  })
})
