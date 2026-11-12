import { describe, expect, it } from 'vitest'
import { APPROVALS, docsFailure, docsSafe, elicitationFields, elicitationResponse } from './mapping.ts'

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
  const params = form(
    { notify: { type: 'boolean' }, count: { type: 'integer' }, name: { type: 'string' } },
    ['name'],
  )

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
    expect(docsFailure({ ...error, codexErrorInfo: 'usageLimitExceeded' }, null)).toBe('Limit reached. Try again later.')
  })
})

// T3 Code's own fixture (apps/server/src/provider/CodexMcpElicitation.test.ts, commit 5c6f2f12):
// the usual connector approval, a required choice whose one-time option is "once".
const safari = {
  mode: 'form',
  message: 'Allow ChatGPT to use Safari?',
  serverName: 'computer-use',
  threadId: 'provider-thread-1',
  turnId: 'turn-1',
  _meta: { app_name: 'Safari', persist: ['session', 'always'] },
  requestedSchema: {
    type: 'object',
    properties: {
      approval: {
        type: 'string',
        oneOf: [
          { const: 'once', title: 'Allow once' },
          { const: 'session', title: 'Allow for this session' },
          { const: 'always', title: 'Always allow Safari' },
        ],
      },
    },
    required: ['approval'],
  },
} satisfies Params

describe('connector approvals', () => {
  it('asks only Allow or not, under the app\'s name', () => {
    expect(APPROVALS['mcpServer/elicitation/request'].block('a1', safari)).toMatchObject({
      title: 'Allow Safari?',
      body: 'Safari needs your OK to continue.',
      fields: [],
    })
  })

  it('Allow picks the one-time choice, as T3 does', () => {
    expect(elicitationResponse(safari, { accept: true, answers: {} })).toEqual({
      action: 'accept',
      content: { approval: 'once' },
      _meta: null,
    })
  })

  it('Allow picks "accept" from an enum and never a remembered choice', () => {
    const params = {
      ...safari,
      requestedSchema: {
        type: 'object',
        properties: {
          approval: { type: 'string', enum: ['accept_for_session', 'accept'], enumNames: ['This session', 'Allow'] },
          remember: { type: 'boolean', title: 'Always allow this app' },
        },
        required: ['approval'],
      },
    } satisfies Params
    expect(elicitationFields(params)).toEqual([])
    expect(elicitationResponse(params, { accept: true, answers: {} })).toEqual({
      action: 'accept',
      content: { approval: 'accept', remember: false },
      _meta: null,
    })
  })

  it('a choice the person fills in must be one of the options', () => {
    const params = form({ size: { type: 'string', title: 'Size', enum: ['small', 'large'], enumNames: ['Small', 'Large'] } }, ['size'])
    expect(elicitationFields(params)).toEqual([{ id: 'size', label: 'Size (Small, Large)' }])
    expect(elicitationResponse(params, { accept: true, answers: { size: 'Large' } })).toMatchObject({ content: { size: 'large' } })
    expect(elicitationResponse(params, { accept: true, answers: { size: 'huge' } })).toMatchObject({ action: 'decline' })
  })
})

describe('docsSafe', () => {
  it('catches provider names run into other words', () => {
    for (const text of ['gpt5', 'GPT4o', 'ChatGPTPlus', 'OpenAIAPI', 'codex_helper', 'askClaude']) expect(docsSafe(text)).toBeNull()
  })

  it('splits acronyms and trailing digits off generic words', () => {
    expect(docsSafe('getAIResponse')).toBeNull()
    expect(docsSafe('model2')).toBeNull()
  })

  it('lets ordinary words that merely contain a name through', () => {
    for (const text of ['philanthropic', 'Claudette', 'Notion · Search pages']) expect(docsSafe(text)).toBe(text)
  })
})
