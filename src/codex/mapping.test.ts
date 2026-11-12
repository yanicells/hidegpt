import { describe, expect, it } from 'vitest'
import { elicitationFields, itemToBlock } from './mapping.ts'

type Params = Parameters<typeof elicitationFields>[0]

describe('elicitationFields', () => {
  it('keeps the valid fields when one property is a boolean or null subschema', () => {
    const params = {
      threadId: 'thr_1',
      turnId: 'turn_1',
      serverName: 'notion',
      mode: 'openai/form',
      _meta: null,
      message: 'Pick a workspace',
      requestedSchema: {
        type: 'object',
        properties: { workspace: { type: 'string', title: 'Workspace', default: 'eva' }, extra: true, gone: null },
      },
    } satisfies Params
    expect(elicitationFields(params)).toEqual([
      { id: 'workspace', label: 'Workspace', initial: 'eva' },
      { id: 'extra', label: 'extra' },
      { id: 'gone', label: 'gone' },
    ])
  })
})

describe('itemToBlock', () => {
  it('titles a connected-app call in Docs’ words, with its names and never its error text in the body', () => {
    const call = (status: string, error: { message: string } | null) =>
      itemToBlock({
        type: 'mcpToolCall',
        id: 'm1',
        server: 'github',
        tool: 'create_issue',
        status,
        error,
      } as unknown as Parameters<typeof itemToBlock>[0])
    expect(call('completed', null)).toMatchObject({ title: 'Used a connected app', body: 'github · create_issue' })
    expect(call('failed', { message: 'Bad credentials' })).toMatchObject({
      title: 'A connected app didn’t respond',
      body: 'github · create_issue',
    })
  })
})
