import { describe, expect, it } from 'vitest'
import { stubThread } from './FakeCodex'
import { docsFailure, elicitationFields, elicitationResponse, toDoc } from './mapping.ts'

type Params = Parameters<typeof elicitationFields>[0]

const form = (properties: Record<string, unknown>, required?: ReadonlyArray<string>) =>
  ({
    threadId: 'thr_1',
    turnId: 'turn_1',
    serverName: 'notion',
    mode: 'openai/form',
    _meta: null,
    message: 'Pick a workspace',
    requestedSchema: { type: 'object', properties, ...(required ? { required } : {}) },
  }) as Params

describe('elicitationFields', () => {
  it('skips properties that are not object subschemas', () => {
    const params = form({ workspace: { type: 'string', title: 'Workspace', default: 'eva' }, extra: true, gone: null })
    expect(elicitationFields(params)).toEqual([{ id: 'workspace', label: 'Workspace', initial: 'eva' }])
  })
})

describe('elicitationResponse', () => {
  const params = form({ notify: { type: 'boolean' }, count: { type: 'integer' }, name: { type: 'string' } }, ['name'])

  it('sends booleans and numbers as JSON, not strings', () => {
    expect(elicitationResponse(params, { accept: true, answers: { notify: 'yes', count: '3', name: 'eva' } })).toEqual({
      action: 'accept',
      content: { notify: true, count: 3, name: 'eva' },
      _meta: null,
    })
  })

  it('declines when a required field is empty', () => {
    expect(elicitationResponse(params, { accept: true, answers: { notify: 'yes', name: '  ' } })).toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    })
  })
})

describe('docsFailure', () => {
  it('never repeats the provider text', () => {
    const error = {
      message: 'Visit https://status.openai.com, the model is overloaded',
      codexErrorInfo: 'serverOverloaded' as const,
      additionalDetails: null,
      misalignment: null,
    }
    expect(docsFailure(error, null)).toBe('Docs could not connect. Try again in a moment.')
    expect(docsFailure({ ...error, codexErrorInfo: 'usageLimitExceeded' }, null)).toBe(
      'Limit reached. Try again later.',
    )
  })
})

describe('toDoc', () => {
  it('names a thread only by the name Codex gave it, never by its first prompt', () => {
    expect(toDoc(stubThread('thr_1', 'Write a 500-word essay'))).toMatchObject({
      name: null,
      preview: 'Write a 500-word essay',
    })
    expect(toDoc(stubThread('thr_2', 'Write a 500-word essay', 'Essay')).name).toBe('Essay')
  })
})
