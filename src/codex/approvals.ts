import type * as CodexRpc from '../vendor/effect-codex-app-server/rpc.ts'

import type { ApprovalBlock, ApprovalReply, SuggestionKind } from '../shared/model'

/**
 * Codex server requests that wait on the person, as Docs approval blocks.
 * Each spec turns the request params into display data and the person's
 * reply into the exact response type the method expects.
 */

export type ApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'mcpServer/elicitation/request'
  | 'item/tool/requestUserInput'
  | 'execCommandApproval'
  | 'applyPatchApproval'

type Params<M extends ApprovalMethod> = CodexRpc.ServerRequestParamsByMethod[M]
type Response<M extends ApprovalMethod> = CodexRpc.ServerRequestResponsesByMethod[M]

export type ApprovalSpec<M extends ApprovalMethod> = {
  /** Legacy methods name the thread `conversationId`. */
  readonly threadId: (params: Params<M>) => string
  readonly block: (id: string, params: Params<M>) => ApprovalBlock
  readonly response: (params: Params<M>, reply: ApprovalReply) => Response<M>
}

const block = (
  id: string,
  suggestion: SuggestionKind,
  title: string,
  body: string,
  extra: Partial<Pick<ApprovalBlock, 'fields' | 'questions'>> = {},
): ApprovalBlock => ({ kind: 'approval', id, suggestion, title, body, fields: [], questions: [], resolved: null, ...extra })

const legacyDecision = (reply: ApprovalReply) =>
  reply.accept ? ('approved' as const) : { denied: { rejection: 'skipped' } }

type ElicitationParams = Params<'mcpServer/elicitation/request'>

const isForm = (params: ElicitationParams) =>
  params.mode === 'form' || params.mode === 'openai/form' || params.mode === 'openaiForm'

function elicitationFields(params: ElicitationParams) {
  if (!('requestedSchema' in params)) return []
  const schema = params.requestedSchema as { properties?: Record<string, { title?: unknown; default?: unknown }> } | null
  const properties = schema?.properties ?? {}
  return Object.entries(properties).map(([id, schema]) => ({
    id,
    label: typeof schema.title === 'string' && schema.title ? schema.title : id,
    ...(schema.default != null ? { initial: String(schema.default) } : {}),
  }))
}

export const APPROVALS: { readonly [M in ApprovalMethod]: ApprovalSpec<M> } = {
  'item/commandExecution/requestApproval': {
    threadId: (params) => params.threadId,
    block: (id, params) => block(id, 'add', 'Run command?', params.command ?? params.reason ?? 'Command'),
    response: (_params, reply) => ({ decision: reply.accept ? 'accept' : 'decline' }),
  },
  execCommandApproval: {
    threadId: (params) => params.conversationId,
    block: (id, params) => block(id, 'add', 'Run command?', params.command.join(' ') || params.reason || 'Command'),
    response: (_params, reply) => ({ decision: legacyDecision(reply) }),
  },
  'item/fileChange/requestApproval': {
    threadId: (params) => params.threadId,
    block: (id, params) => block(id, 'replace', 'Apply file changes?', params.reason ?? 'The assistant wants to edit files.'),
    response: (_params, reply) => ({ decision: reply.accept ? 'accept' : 'decline' }),
  },
  applyPatchApproval: {
    threadId: (params) => params.conversationId,
    block: (id, params) => block(id, 'replace', 'Apply file changes?', params.reason ?? 'The assistant wants to edit files.'),
    response: (_params, reply) => ({ decision: legacyDecision(reply) }),
  },
  'item/permissions/requestApproval': {
    threadId: (params) => params.threadId,
    block: (id, params) => block(id, 'format', 'Grant extra access?', params.reason ?? 'The assistant needs more permissions.'),
    response: (params, reply) => ({
      permissions: reply.accept
        ? {
            ...(params.permissions.network ? { network: params.permissions.network } : {}),
            ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
          }
        : {},
      scope: 'turn',
    }),
  },
  'mcpServer/elicitation/request': {
    threadId: (params) => params.threadId,
    block: (id, params) =>
      block(
        id,
        'add',
        `Continue with ${params.serverName}?`,
        params.mode === 'openai/userVerification' ? params.description || params.title : params.message,
        { fields: elicitationFields(params) },
      ),
    response: (params, reply) =>
      reply.accept
        ? { action: 'accept', content: isForm(params) ? { ...reply.answers } : null, _meta: null }
        : { action: 'cancel', content: null, _meta: null },
  },
  'item/tool/requestUserInput': {
    threadId: (params) => params.threadId,
    block: (id, params) =>
      block(id, 'question', 'The assistant needs input', params.questions.map((q) => q.question).filter(Boolean).join('\n') || 'Continue?', {
        questions: params.questions.map((question) => ({
          id: question.id,
          question: question.question,
          options: question.options?.map((option) => option.label) ?? [],
          allowText: Boolean(question.isOther) || !question.options?.length,
        })),
      }),
    response: (params, reply) => ({
      answers: Object.fromEntries(
        params.questions.map((question) => {
          const value = reply.accept ? (reply.answers[question.id] ?? '') : ''
          return [question.id, { answers: value ? [value] : [] }]
        }),
      ),
    }),
  },
}

export const APPROVAL_METHODS = Object.keys(APPROVALS) as ReadonlyArray<ApprovalMethod>
