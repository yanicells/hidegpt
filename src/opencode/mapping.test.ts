import type { PermissionRequest, ToolPart } from '@opencode-ai/sdk/v2/client'
import { describe, expect, it } from 'vitest'

import { permissionBlock, questionBlock, STEP_FAILED, toolCallout } from './mapping'

const part = (tool: string, state: Record<string, unknown>) =>
  ({ id: 'prt_1', sessionID: 's', messageID: 'm', type: 'tool', callID: 'c', tool, state }) as unknown as ToolPart

const completed = (tool: string, output: string) =>
  part(tool, { status: 'completed', input: {}, output, title: '', metadata: {}, time: { start: 1, end: 2 } })

const view = (callout: ReturnType<typeof toolCallout>) => callout && [callout.title, callout.body]

describe('toolCallout', () => {
  it('titles each tool by kind, never by its name', () => {
    const titles = [
      'bash',
      'edit',
      'write',
      'apply_patch',
      'read',
      'glob',
      'grep',
      'list',
      'webfetch',
      'websearch',
      'codesearch',
      'task',
      'mcp__claude_ai_Notion__notion-search',
      'notion_create_page',
      'openai_ask',
      'skill',
    ].map((tool) => toolCallout(completed(tool, ''))?.title)
    expect(titles).toEqual([
      'Ran a command',
      'Edited a file',
      'Edited a file',
      'Edited a file',
      'Opened a file',
      'Searched files',
      'Searched files',
      'Searched files',
      'Opened a link',
      'Looked something up',
      'Looked something up',
      'Background task',
      'Notion · notion search',
      'Notion · create page',
      'A connected app · ask',
      'Did a step',
    ])
  })

  it('draws no callout for the question tool, whose card asks it, or for the to-do list', () => {
    expect(toolCallout(completed('question', 'Week 3'))).toBeNull()
    expect(toolCallout(completed('todowrite', '[]'))).toBeNull()
  })

  it('says a step is running until it finishes, and shows a fixed sentence, not the error, when it fails', () => {
    expect(view(toolCallout(part('bash', { status: 'pending', input: {}, raw: '' })))).toEqual([
      'Running a command',
      '',
    ])
    expect(view(toolCallout(completed('bash', 'On branch main')))).toEqual(['Ran a command', 'On branch main'])
    const failed = part('bash', {
      status: 'error',
      input: {},
      error: 'OpenCode: tool crashed',
      time: { start: 1, end: 2 },
    })
    expect(view(toolCallout(failed))).toEqual(['Ran a command', STEP_FAILED])
  })

  it("shows a subtask's description only, never its report or session id", () => {
    const report = 'Found 3 readings.\n\n<task_metadata>\nsession_id: ses_1\n</task_metadata>'
    expect(view(toolCallout(completed('task', report)))).toEqual(['Background task', ''])
  })

  it("shows a read's content without OpenCode's envelope, and keeps text after it", () => {
    const file = '<path>/n/a.md</path>\n<type>file</type>\n<content>\n1: Week 3\n2: Attention\n</content>\nMore below.'
    expect(toolCallout(completed('read', file))?.body).toBe('1: Week 3\n2: Attention\nMore below.')
    const folder = '<path>/n</path>\n<type>directory</type>\n<entries>\na.md\nb.md\n</entries>'
    expect(toolCallout(completed('read', folder))?.body).toBe('a.md\nb.md')
  })
})

const permission = (name: string, patterns: string[]): PermissionRequest => ({
  id: 'per_1',
  sessionID: 's',
  permission: name,
  patterns,
  metadata: {},
  always: [],
})

describe('approval cards', () => {
  it('asks by permission kind and quotes what it would touch', () => {
    const cards = [
      permission('bash', ['git status', 'ls']),
      permission('edit', ['notes/a.md']),
      permission('read', ['notes/a.md']),
      permission('external_directory', ['/tmp/*']),
      permission('webfetch', ['https://x.test']),
      permission('doom_loop', []),
    ].map(permissionBlock)
    expect(cards.map((card) => [card.suggestion, card.title, card.body])).toEqual([
      ['add', 'Run this command?', 'git status, ls'],
      ['add', 'Edit this file?', 'notes/a.md'],
      ['add', 'Open this file?', 'notes/a.md'],
      ['add', 'Open this file?', '/tmp/*'],
      ['add', 'Look this up online?', 'https://x.test'],
      ['add', 'Allow this step?', ''],
    ])
  })

  it('titles a question in Docs words', () => {
    const card = questionBlock({
      id: 'que_1',
      sessionID: 's',
      questions: [{ question: 'Which week?', header: 'Week', options: [] }],
    })
    expect([card.title, card.body]).toEqual(['Needs your reply', 'Which week?'])
  })
})
