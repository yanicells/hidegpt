import { describe, expect, it } from 'vitest'

import {
  FailureClass,
  NoticeKind,
  RequestKind,
  RequestStatus,
  ToolKind,
  ToolStatus,
  type AssistantItem,
  type Item,
  type RequestItem,
  type ToolItem,
} from '../../provider/events'
import type { Block } from '../../shared/model'
import { stealthViolations } from '../../shared/stealth'
import { connectedAppTitle, presentFailure, presentItem, presentItems, toolRequestTitle, toolTitle } from './present'

const tool = (kind: ToolItem['tool'], status: ToolItem['status'], extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool',
  id: `${kind}-${status}`,
  tool: kind,
  status,
  subject: null,
  output: '',
  ...extra,
})
const request = (kind: RequestItem['request'], status: RequestItem['status']): RequestItem => ({
  kind: 'request',
  id: `${kind}-${status}`,
  request: kind,
  status,
  subject: null,
  detail: '',
  fields: [],
  questions: [],
})
const assistant = (id: string, text: string): AssistantItem => ({ kind: 'assistant', id, text, phase: 'final' })

/** Every sentence a block carries that present.ts wrote (the item's own data is empty here). */
const wording = (block: Block): string[] =>
  block.kind === 'callout' || block.kind === 'approval' ? [block.title, block.body] : []

describe('present', () => {
  it('words every tool, request, notice and failure without naming a model or vendor', () => {
    const items: Item[] = [
      ...ToolKind.literals.flatMap((kind) => ToolStatus.literals.map((status) => tool(kind, status))),
      ...RequestKind.literals.flatMap((kind) => RequestStatus.literals.map((status) => request(kind, status))),
      ...NoticeKind.literals.map((notice): Item => ({ kind: 'notice', id: notice, notice, detail: null })),
    ]
    const sentences = [
      ...items.flatMap((item) => wording(presentItem(item))),
      ...FailureClass.literals.map((failureClass) =>
        presentFailure({ class: failureClass, detail: 'Claude failed', retryable: null, resetAt: null }),
      ),
      presentFailure({ class: 'usage_limit', detail: '', retryable: false, resetAt: Date.UTC(2026, 10, 13, 9) }),
    ]
    for (const sentence of sentences) expect(stealthViolations(sentence), sentence).toEqual([])
    // Each tool state reads differently.
    expect(new Set(ToolStatus.literals.map((status) => wording(presentItem(tool('command', status)))[0])).size).toBe(3)
  })

  it('words a failure by class, with its report id so the log line can be found', () => {
    const failure = { class: 'auth', detail: 'Please run /login', retryable: false, resetAt: null } as const
    expect(presentFailure(failure)).toBe('This account signs in outside Docs. Sign in, then use Tools → Refresh.')
    expect(presentFailure({ ...failure, reportId: '3f2a9c1e' })).toBe(
      'This account signs in outside Docs. Sign in, then use Tools → Refresh. (Report 3f2a9c1e)',
    )
  })

  it('words the titles and card questions adapters still take from here', () => {
    const sentences = [
      ...ToolKind.literals.flatMap((kind) => [
        toolRequestTitle(kind),
        ...ToolStatus.literals.map((status) => toolTitle(kind, status)),
      ]),
      connectedAppTitle('', ''),
      connectedAppTitle('notion', 'search'),
      toolRequestTitle('mcp_tool', 'notion'),
    ]
    for (const sentence of sentences) expect(stealthViolations(sentence), sentence).toEqual([])
    expect([connectedAppTitle('notion', 'search'), connectedAppTitle('', '')]).toEqual([
      'Notion · search',
      'A connected app',
    ])
    expect([toolRequestTitle('mcp_tool', 'notion'), toolRequestTitle('mcp_tool'), toolRequestTitle('command')]).toEqual(
      ['Use Notion?', 'Allow this step?', 'Run this command?'],
    )
  })

  it('shows a request’s status the way the suggestion card expects', () => {
    const shown = (status: RequestItem['status']) => presentItem(request('command', status))
    expect(shown('pending')).toMatchObject({ suggestion: 'add', resolved: null, pending: false })
    expect(shown('sending')).toMatchObject({ resolved: null, pending: true })
    expect(shown('accepted')).toMatchObject({ resolved: 'accepted' })
    expect(shown('declined')).toMatchObject({ resolved: 'skipped' })
    expect(shown('expired')).toMatchObject({ resolved: 'skipped' })
  })

  it('keeps an adapter’s own title unless it would leak, and puts output after the subject', () => {
    const titled = (title: string) => tool('other', 'completed', { legacy: { title } })
    expect(presentItem(titled('Searched the web'))).toMatchObject({ title: 'Searched the web' })
    for (const leak of ['Agent · spawn', 'Using mcp__github__create_issue', 'collabAgentToolCall', 'gpt5 · CLI']) {
      expect(presentItem(titled(leak)), leak).toMatchObject({ title: 'Did a step' })
    }
    expect(presentItem(tool('command', 'running', { subject: 'ls', output: 'a\nb' }))).toMatchObject({
      body: 'ls\na\nb',
    })
  })

  it('returns the same block for the same item, and only rebuilds what changed', () => {
    const first = assistant('a1', 'Hello')
    const second = assistant('a2', 'World')
    expect(presentItem(first)).toBe(presentItem(first))

    const before = [first, second]
    expect(presentItems(before)).toBe(presentItems(before))

    const grown = { ...second, text: 'World!' }
    const after = presentItems([first, grown])
    expect(after[0]).toBe(presentItems(before)[0])
    expect(after[1]).not.toBe(presentItems(before)[1])
    expect(after[1]).toMatchObject({ kind: 'agent', text: 'World!' })
  })
})
