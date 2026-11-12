import { describe, expect, it } from 'vitest'
import { elicitationFields } from './mapping.ts'

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
