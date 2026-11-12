import { describe, expect, it } from 'vitest'
import { APPROVALS, BANNED_WORDS, docsFailure, docsSafe, elicitationFields, elicitationResponse, itemToBlock } from './mapping.ts'

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
    const params = form(
      { size: { type: 'string', title: 'Size', enum: ['small', 'large', 'gpt5'], enumNames: ['Small', 'Large', 'GPT-5'] } },
      ['size'],
    )
    // The GPT-5 choice keeps its place under a neutral name the person can still pick.
    expect(elicitationFields(params)).toEqual([{ id: 'size', label: 'Size (Small, Large, Option 3)' }])
    expect(elicitationResponse(params, { accept: true, answers: { size: 'Large' } })).toMatchObject({ content: { size: 'large' } })
    expect(elicitationResponse(params, { accept: true, answers: { size: 'option 3' } })).toMatchObject({ content: { size: 'gpt5' } })
    expect(elicitationResponse(params, { accept: true, answers: { size: 'huge' } })).toMatchObject({ action: 'decline' })
  })
})

describe('docsSafe', () => {
  const plural = (word: string) => (word === 'codex' ? 'codexes' : `${word}s`)
  const capitalized = (word: string) => word[0].toUpperCase() + word.slice(1)

  it('blocks every house-list word, singular or plural, in any case, inside a sentence', () => {
    const forms = BANNED_WORDS.flatMap((word) =>
      [word, plural(word)].flatMap((form) => [form, capitalized(form), form.toUpperCase()]),
    )
    const leaks = forms.map((form) => `Ask the ${form} for help.`).filter((sentence) => docsSafe(sentence) !== null)
    expect(leaks).toEqual([])
  })

  it('blocks what reviewers found on the page', () => {
    const found = [
      'Summarize with LLMs',
      'Search custom GPTs',
      'custom ChatGPTs',
      'Claudes',
      'OpenAIs',
      'Anthropics',
      'Opencodes',
      'MCP error -32000: Connection closed',
      'Allow the MCP server to continue?',
      'mcp · mcp__github__search',
      'HideGPT',
      'hidegpt',
      'A.I. features',
    ]
    expect(found.filter((text) => docsSafe(text) !== null)).toEqual([])
  })

  it('blocks provider names run into other words', () => {
    for (const text of ['gpt5', 'GPT4o', 'ChatGPTPlus', 'OpenAIAPI', 'xOPENAIAPI', 'codex_helper', 'askClaude']) expect(docsSafe(text)).toBeNull()
  })

  it('splits acronyms and trailing digits off generic words', () => {
    expect(docsSafe('getAIResponse')).toBeNull()
    expect(docsSafe('model2')).toBeNull()
  })

  it('sees through look-alike letters and invisible characters', () => {
    expect(docsSafe('Ｃｌａｕｄｅ')).toBeNull()
    expect(docsSafe('Co\u200Bdex')).toBeNull()
  })

  it('lets ordinary words that merely contain a name through', () => {
    const ordinary = ['philanthropic', 'Claudette', 'said', 'climb', 'client', 'bottle', 'remodel', 'tokenize', 'Notion · Search pages']
    expect(ordinary.filter((text) => docsSafe(text) !== text)).toEqual([])
  })
})

describe('provider text on the page', () => {
  it('a failed tool shows only its status, never its error text', () => {
    const item = {
      type: 'mcpToolCall' as const,
      id: 'm1',
      server: 'notion',
      tool: 'search',
      status: 'failed' as const,
      arguments: {},
      error: { message: 'Notion returned 500: page missing' },
    }
    expect(itemToBlock(item)).toMatchObject({ body: 'Did not finish' })
  })

  it('approval reasons in provider words fall back to Docs wording', () => {
    const base = { threadId: 'thr_1', turnId: 'turn_1', itemId: 'p1', startedAtMs: 1 }
    const edit = APPROVALS['item/fileChange/requestApproval']
    expect(edit.block('a1', { ...base, reason: 'The agent will rewrite the intro' })).toMatchObject({ body: 'Some files will change.' })
    expect(edit.block('a1', { ...base, reason: 'Rewrite the intro' })).toMatchObject({ body: 'Rewrite the intro' })
  })

  it('a question in provider words is renamed, and its renamed choice goes back as written', () => {
    const spec = APPROVALS['item/tool/requestUserInput']
    const params = {
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemId: 'i1',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'q1',
          header: '',
          isOther: false,
          isSecret: false,
          question: 'Which model should the agent use?',
          options: [
            { label: 'GPT-5', description: '' },
            { label: 'Fast', description: '' },
          ],
        },
      ],
    }
    expect(spec.block('a1', params)).toMatchObject({ body: 'Continue?', questions: [{ question: 'Question 1', options: ['Option 1', 'Fast'] }] })
    expect(spec.response(params, { accept: true, answers: { q1: 'Option 1' } })).toEqual({ answers: { q1: { answers: ['GPT-5'] } } })
  })
})
