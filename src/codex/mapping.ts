import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type {
  AccountSummary,
  ApprovalBlock,
  ApprovalReply,
  Block,
  DocSummary,
  ModelOption,
  ProjectSummary,
  ToolServer,
  UserBlock,
} from '../shared/model'
import type * as CodexRpc from '../vendor/effect-codex-app-server/rpc.ts'
import { ClientRequest__ReasoningEffort } from '../vendor/effect-codex-app-server/schema.ts'

/**
 * Pure mapping between Codex app-server wire types and HideGPT's domain model:
 * threads to documents, items to blocks, models, projects, MCP servers and the
 * account to their summaries, and server requests to approval blocks (and the
 * person's reply back to the exact response each method expects). No I/O.
 */

type Result<M extends CodexRpc.ClientRequestMethod> = CodexRpc.ClientRequestResponsesByMethod[M]

export type Thread = Result<'thread/list'>['data'][number]
export type Model = Result<'model/list'>['data'][number]
export type Project = Result<'project/list'>['data'][number]
export type McpServer = Result<'mcpServerStatus/list'>['data'][number]
export type Account = Result<'account/read'>['account']
export type ThreadItem = CodexRpc.ServerNotificationParamsByMethod['item/completed']['item']
export type Turn = Result<'thread/turns/list'>['data'][number]
type UserInput = Extract<ThreadItem, { type: 'userMessage' }>['content'][number]
type ReasoningEffort = typeof ClientRequest__ReasoningEffort.Type

/** Codex's error text, reworded where Docs can say what to do. */
export function formatCodexError(message: string): string {
  if (/active writer|thread-store conflict/i.test(message)) {
    return 'This document is open in ChatGPT or another window. Close it there, then open it here.'
  }
  return message
}

/** The toolbar's effort as `turn/start` accepts it; anything Codex would reject inherits the thread's effort. */
export const toReasoningEffort = (effort: string | null): ReasoningEffort | null =>
  Schema.is(ClientRequest__ReasoningEffort)(effort) ? effort : null

export function toDoc(thread: Thread): DocSummary {
  return {
    id: thread.id,
    name: thread.name ?? null,
    preview: thread.preview,
    updatedAt: thread.recencyAt ?? thread.updatedAt,
    cwd: thread.cwd,
    projectId: thread.projectId ?? null,
  }
}

export function toModelOption(model: Model): ModelOption {
  return {
    id: model.model,
    label: model.displayName,
    efforts: model.supportedReasoningEfforts.map((item) => item.reasoningEffort),
    defaultEffort: model.defaultReasoningEffort ?? null,
    serviceTiers: (model.serviceTiers ?? []).map((tier) => ({ id: tier.id, name: tier.name })),
    isDefault: model.isDefault,
  }
}

export function toProject(project: Project): ProjectSummary {
  return { id: project.id, name: project.name, roots: project.roots.map((root) => ({ path: root.path })) }
}

export function toTool(server: McpServer): ToolServer {
  return {
    name: server.name,
    needsConnect:
      server.authStatus === 'notLoggedIn' ||
      server.runtimeStatus === 'authenticationRequired' ||
      server.runtimeStatus === 'failed',
  }
}

export function toAccount(account: Account): AccountSummary | null {
  if (!account) return null
  if (account.type === 'chatgpt') return { kind: 'chatgpt', label: account.email ?? 'ChatGPT' }
  if (account.type === 'apiKey') return { kind: 'apiKey', label: 'API key' }
  return { kind: 'other', label: 'Account' }
}

// Thread items as page blocks. Reasoning, plans, and subagent traffic stay off the page.

export function userBlock(id: string, content: ReadonlyArray<UserInput>): UserBlock {
  const text: string[] = []
  const images: string[] = []
  const skills: string[] = []
  for (const part of content) {
    if (part.type === 'text') text.push(part.text)
    else if (part.type === 'image' && 'url' in part) images.push(part.url)
    else if (part.type === 'localImage') images.push(part.path)
    else if (part.type === 'skill') skills.push(part.name)
  }
  return {
    kind: 'user',
    id,
    text: text.filter(Boolean).join('\n'),
    ...(images.length ? { images } : {}),
    ...(skills.length ? { skills } : {}),
  }
}

function callout(id: string, title: string, body: string): Block {
  return { kind: 'callout', id, title, body }
}

export function itemToBlock(item: ThreadItem): Block | null {
  switch (item.type) {
    case 'userMessage':
      return userBlock(item.id, item.content)
    case 'agentMessage':
      return { kind: 'agent', id: item.id, text: item.text, ...(item.phase === 'commentary' ? { commentary: true } : {}) }
    case 'reasoning':
    case 'plan':
    case 'hookPrompt':
    case 'subAgentActivity':
    case 'sleep':
      return null
    case 'commandExecution': {
      const output = item.aggregatedOutput?.trim()
      return callout(
        item.id,
        item.status === 'completed' ? 'Ran a command' : 'Running a command',
        output ? `${item.command}\n${output}` : item.command,
      )
    }
    case 'fileChange':
      return callout(
        item.id,
        `${item.changes.length} file change${item.changes.length === 1 ? '' : 's'}`,
        item.changes.map((change) => change.path).join('\n'),
      )
    case 'mcpToolCall':
      return callout(item.id, `${item.server} · ${item.tool}`, item.error?.message ?? item.status)
    case 'dynamicToolCall':
      return callout(item.id, item.namespace ? `${item.namespace} · ${item.tool}` : item.tool, item.status)
    case 'webSearch':
      return callout(item.id, 'Looked something up', item.query)
    case 'imageView':
      return callout(item.id, 'Image', item.path)
    case 'imageGeneration':
      return callout(item.id, 'Generated image', item.savedPath ?? item.revisedPrompt ?? item.status)
    case 'collabAgentToolCall':
      return callout(item.id, `Agent · ${item.tool}`, item.prompt ?? item.status)
    case 'contextCompaction':
      return callout(item.id, 'Compacted context', '')
    case 'enteredReviewMode':
      return callout(item.id, 'Review', item.review)
    case 'exitedReviewMode':
      return callout(item.id, 'Left review', item.review)
    case 'functionCallOutput':
      return callout(item.id, item.name, item.namespace ?? '')
    default: {
      // Unreachable while the ThreadItem union is closed: a newer item type fails to decode, and
      // the client logs and drops that notification. Kept so a widened union still renders.
      const unknown: { readonly id: string; readonly type: string } = item
      return callout(unknown.id, unknown.type, '')
    }
  }
}

export function blocksFromTurns(turns: ReadonlyArray<Turn>): Block[] {
  const blocks: Block[] = []
  for (const turn of turns) {
    for (const item of turn.items) {
      const block = itemToBlock(item)
      if (block) blocks.push(block)
    }
  }
  return blocks
}

// Server requests that wait on the person, as Docs approval blocks. Each spec turns the
// request params into display data and the person's reply into the method's response.

export type ApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'mcpServer/elicitation/request'
  | 'item/tool/requestUserInput'
  | 'execCommandApproval'
  | 'applyPatchApproval'

type ApprovalParams<M extends ApprovalMethod> = CodexRpc.ServerRequestParamsByMethod[M]
type ApprovalResponse<M extends ApprovalMethod> = CodexRpc.ServerRequestResponsesByMethod[M]

export type ApprovalSpec<M extends ApprovalMethod> = {
  /** Legacy methods name the thread `conversationId`. */
  readonly threadId: (params: ApprovalParams<M>) => string
  readonly block: (id: string, params: ApprovalParams<M>) => ApprovalBlock
  readonly response: (params: ApprovalParams<M>, reply: ApprovalReply) => ApprovalResponse<M>
}

const block = (
  id: string,
  title: string,
  body: string,
  extra: Partial<Pick<ApprovalBlock, 'fields' | 'questions'>> = {},
): ApprovalBlock => ({ kind: 'approval', id, title, body, fields: [], questions: [], resolved: null, ...extra })

const legacyDecision = (reply: ApprovalReply) =>
  reply.accept ? ('approved' as const) : { denied: { rejection: 'skipped' } }

type ElicitationParams = ApprovalParams<'mcpServer/elicitation/request'>

const isForm = (params: ElicitationParams) =>
  params.mode === 'form' || params.mode === 'openai/form' || params.mode === 'openaiForm'

/** The part of an elicitation's `requestedSchema` the form reads; `openai/form` sends it as untyped JSON. */
const ElicitationProperties = Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) })
const ElicitationField = Schema.Struct({
  title: Schema.optionalKey(Schema.Unknown),
  default: Schema.optionalKey(Schema.Unknown),
})
const decodeElicitationProperties = Schema.decodeUnknownOption(ElicitationProperties)
const decodeElicitationField = Schema.decodeUnknownOption(ElicitationField)

/** Form fields from `requestedSchema`. Each property decodes on its own, so one odd entry
 *  (JSON Schema allows `true` or `null` subschemas) can't hide the rest. */
export function elicitationFields(params: ElicitationParams) {
  if (!('requestedSchema' in params)) return []
  const properties = Option.match(decodeElicitationProperties(params.requestedSchema), {
    onNone: () => ({}),
    onSome: (form) => form.properties,
  })
  return Object.entries(properties).map(([id, raw]) => {
    const schema: { readonly title?: unknown; readonly default?: unknown } = Option.getOrElse(
      decodeElicitationField(raw),
      () => ({}),
    )
    return {
      id,
      label: typeof schema.title === 'string' && schema.title ? schema.title : id,
      ...(schema.default != null ? { initial: String(schema.default) } : {}),
    }
  })
}

export const APPROVALS: { readonly [M in ApprovalMethod]: ApprovalSpec<M> } = {
  'item/commandExecution/requestApproval': {
    threadId: (params) => params.threadId,
    block: (id, params) => block(id, 'Run command?', params.command ?? params.reason ?? 'Command'),
    response: (_params, reply) => ({ decision: reply.accept ? 'accept' : 'decline' }),
  },
  execCommandApproval: {
    threadId: (params) => params.conversationId,
    block: (id, params) => block(id, 'Run command?', params.command.join(' ') || params.reason || 'Command'),
    response: (_params, reply) => ({ decision: legacyDecision(reply) }),
  },
  'item/fileChange/requestApproval': {
    threadId: (params) => params.threadId,
    block: (id, params) => block(id, 'Apply file changes?', params.reason ?? 'The assistant wants to edit files.'),
    response: (_params, reply) => ({ decision: reply.accept ? 'accept' : 'decline' }),
  },
  applyPatchApproval: {
    threadId: (params) => params.conversationId,
    block: (id, params) => block(id, 'Apply file changes?', params.reason ?? 'The assistant wants to edit files.'),
    response: (_params, reply) => ({ decision: legacyDecision(reply) }),
  },
  'item/permissions/requestApproval': {
    threadId: (params) => params.threadId,
    block: (id, params) => block(id, 'Grant extra access?', params.reason ?? 'The assistant needs more permissions.'),
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
      block(id, 'The assistant needs input', params.questions.map((q) => q.question).filter(Boolean).join('\n') || 'Continue?', {
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
