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
type McpToolCall = Extract<ThreadItem, { type: 'mcpToolCall' }>
export type TurnError = NonNullable<CodexRpc.ServerNotificationParamsByMethod['turn/completed']['turn']['error']>
export type ErrorInfo = TurnError['codexErrorInfo']
export type RateLimits = CodexRpc.ServerNotificationParamsByMethod['account/rateLimits/updated']['rateLimits']

// ---- Docs wording -------------------------------------------------------------
// Text that reaches the page or a banner must read like Docs: no product or AI words, no links.
// These helpers are the only way provider text gets there; ARCH-5 moves them into `present.ts`.

const PROVIDER_WORDS =
  /\b(ai|assistants?|agents?|models?|prompts?|llms?|tokens?|claude|codex|opencode|chatgpt|anthropic|openai|gpt|copilot|bots?)\b/i
/** Product names are distinctive enough to catch anywhere, even run together (`OpenAIAPI`). */
const PRODUCT_NAMES = /claude|codex|opencode|chatgpt|anthropic|openai|copilot|gpt[-_ ]?\d/i
/** Splits identifiers into words, so `chatgpt_search`, `codexHelper`, `gpt5` and `OpenAIAPI` are caught too. */
const words = (text: string) =>
  text
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .replace(/_/g, ' ')
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi

/** Provider text with links removed, or null when what is left would give the provider away. */
export function docsSafe(text: string | null | undefined): string | null {
  const cleaned = (text ?? '').replace(LINK, '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim()
  return cleaned && !PROVIDER_WORDS.test(words(cleaned)) && !PRODUCT_NAMES.test(cleaned) ? cleaned : null
}

/** Codex's request error text, reworded where Docs can say what to do. */
export function formatCodexError(message: string): string {
  if (/active writer|thread-store conflict/i.test(message)) {
    return 'This document is open in another window. Close it there, then open it here.'
  }
  return docsSafe(message) ?? 'Docs could not do that. Try again.'
}

// Adapted from T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/orchestration-v2/
// Adapters/CodexAdapterV2.ts (`codexErrorInfoCode`, `codexUsageLimitError`) and
// apps/server/src/provider/codexUsageLimits.ts (`codexUsageLimitResetAt`) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

function errorCode(info: ErrorInfo | undefined): string | null {
  if (typeof info === 'string') return info
  return info && typeof info === 'object' ? (Object.keys(info)[0] ?? null) : null
}

function errorHttpStatus(info: ErrorInfo | undefined): number | null {
  const detail: unknown = info && typeof info === 'object' ? Object.values(info)[0] : undefined
  return detail && typeof detail === 'object' && 'httpStatusCode' in detail && typeof detail.httpStatusCode === 'number'
    ? detail.httpStatusCode
    : null
}

function isUsageLimit(error: TurnError): boolean {
  const code = errorCode(error.codexErrorInfo)
  return (
    code === 'usageLimitExceeded' ||
    code === 'rateLimitExceeded' ||
    (code === 'responseTooManyFailedAttempts' && errorHttpStatus(error.codexErrorInfo) === 429) ||
    /usage limit|rate limit/i.test(error.message)
  )
}

/** When every exhausted allowance window has reset (epoch ms), or null when that isn't known. */
export function usageLimitResetAt(limits: RateLimits | null): number | null {
  if (!limits || (limits.limitId && limits.limitId !== 'codex')) return null
  const exhausted = [limits.primary, limits.secondary].filter((window) => window != null && window.usedPercent >= 100)
  if (exhausted.length === 0 || exhausted.some((window) => !window?.resetsAt)) return null
  return Math.max(...exhausted.map((window) => (window?.resetsAt ?? 0) * 1000))
}

const clockTime = (epochMs: number) => {
  const at = new Date(epochMs)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** A failed turn as one Docs sentence: a known cause gets its own, anything else a neutral one. */
export function docsFailure(error: TurnError, resetAt: number | null): string {
  if (isUsageLimit(error)) return resetAt ? `Limit reached. Try again at ${clockTime(resetAt)}.` : 'Limit reached. Try again later.'
  const code = errorCode(error.codexErrorInfo)
  if (code === 'contextWindowExceeded') return 'This document is too long to continue. Start a new document.'
  if (code === 'unauthorized') return 'Sign in again to continue.'
  if (code === 'serverOverloaded' || code?.startsWith('http') || code?.startsWith('responseStream')) {
    return 'Docs could not connect. Try again in a moment.'
  }
  return 'Something went wrong. Try again.'
}

/** The banner while Codex retries on its own; "Reconnecting… 2/5" keeps its count. */
export function retryNotice(message: string): string {
  const progress = /(\d+)\s*\/\s*(\d+)/.exec(message)
  return progress ? `Reconnecting… ${progress[1]}/${progress[2]}` : 'Reconnecting…'
}

const CONNECTOR_SERVER = 'codex_apps'

/** A tool source as the person knows it: the app's own name, never the connector plumbing. */
const sourceName = (appName: string | null | undefined, server: string | null | undefined) =>
  docsSafe(appName) ?? (server && server !== CONNECTOR_SERVER ? docsSafe(server) : null) ?? 'Connected app'

// Adapted from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/provider/CodexToolPresentation.ts (`mcpToolPresentation`) at commit
// 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
/** Title for an MCP tool call: the app's name, never the connector server, then the action. */
function mcpToolTitle(item: McpToolCall): string {
  const app = item.appContext
  const action = docsSafe(app?.actionName) ?? docsSafe(item.tool) ?? 'Action'
  return `${sourceName(app?.appName, item.server)} · ${action}`
}

const STATUS = { inProgress: 'Running', completed: 'Done', failed: 'Did not finish' } as const

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
  if (account.type === 'chatgpt') return { kind: 'chatgpt', label: account.email ?? 'Signed in' }
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
    case 'collabAgentToolCall':
    case 'contextCompaction':
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
      return callout(item.id, mcpToolTitle(item), (item.error && docsSafe(item.error.message)) ?? STATUS[item.status])
    case 'dynamicToolCall': {
      const tool = docsSafe(item.tool) ?? 'Action'
      const namespace = docsSafe(item.namespace)
      return callout(item.id, namespace ? `${namespace} · ${tool}` : tool, STATUS[item.status])
    }
    case 'webSearch':
      return callout(item.id, 'Looked something up', item.query)
    case 'imageView':
      return callout(item.id, 'Image', item.path)
    case 'imageGeneration':
      return callout(item.id, 'Generated image', item.savedPath ?? item.revisedPrompt ?? item.status)
    case 'enteredReviewMode':
      return callout(item.id, 'Review', item.review)
    case 'exitedReviewMode':
      return callout(item.id, 'Left review', item.review)
    case 'functionCallOutput':
      return callout(item.id, docsSafe(item.name) ?? 'Action', docsSafe(item.namespace) ?? '')
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
  /** A reply Docs gives at once, without showing the request; null to ask the person. */
  readonly answerAtOnce?: (params: ApprovalParams<M>) => ApprovalResponse<M> | null
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
type ElicitationResponse = ApprovalResponse<'mcpServer/elicitation/request'>
type Json = typeof Schema.Json.Type

// Adapted from T3 Code (https://github.com/pingdotgg/t3code),
// apps/server/src/provider/CodexMcpElicitation.ts (`describeMcpElicitation`,
// `toMcpElicitationResponse`) at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc.
// MIT License; see THIRD_PARTY_NOTICES.md. HideGPT keeps only the one-time "accept"
// (Docs asks every time), so persistence options are never chosen, and fills the
// remaining fields from what the person typed.

const NullableString = Schema.optionalKey(Schema.NullOr(Schema.String))
const ElicitationMetadata = Schema.Struct({
  app: NullableString,
  app_name: NullableString,
  appName: NullableString,
  connector_name: NullableString,
  connectorName: NullableString,
  target: Schema.optionalKey(Schema.NullOr(Schema.Struct({ app: NullableString, name: NullableString }))),
  tool_params: Schema.optionalKey(Schema.NullOr(Schema.Struct({ app: NullableString, app_name: NullableString }))),
})
const ElicitationField = Schema.Struct({
  type: NullableString,
  title: NullableString,
  description: NullableString,
  default: Schema.optionalKey(Schema.Json),
  enum: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  enumNames: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  oneOf: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ const: Schema.String, title: NullableString })))),
})
type ElicitationField = typeof ElicitationField.Type
const ElicitationForm = Schema.Struct({
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  required: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
})
const decodeMetadata = Schema.decodeUnknownOption(ElicitationMetadata)
const decodeForm = Schema.decodeUnknownOption(ElicitationForm)
const decodeField = Schema.decodeUnknownOption(ElicitationField)

/** The app an MCP request is for, by the name the person knows (never the connector's). */
export function elicitationAppName(params: ElicitationParams): string {
  const meta = Option.getOrUndefined(decodeMetadata(params._meta))
  const fromMessage = 'message' in params ? /^Allow \S+ to use (.+?)\?$/i.exec(params.message)?.[1] : undefined
  const name =
    meta?.app_name ??
    meta?.appName ??
    meta?.app ??
    meta?.target?.app ??
    meta?.target?.name ??
    meta?.tool_params?.app_name ??
    meta?.tool_params?.app ??
    fromMessage ??
    meta?.connector_name ??
    meta?.connectorName
  return sourceName(name, params.serverName)
}

/**
 * The form's fields, each decoded on its own so one odd entry can't hide the rest.
 * JSON Schema allows `true` or `null` subschemas; those describe no field and are skipped.
 */
function formFields(params: ElicitationParams): {
  readonly fields: ReadonlyArray<readonly [string, ElicitationField]>
  readonly required: ReadonlyArray<string>
} | null {
  if (!('requestedSchema' in params)) return null
  const form = Option.getOrUndefined(decodeForm(params.requestedSchema))
  if (!form) return null
  const fields = Object.entries(form.properties ?? {}).flatMap(([id, raw]) =>
    Option.match(decodeField(raw), { onNone: () => [], onSome: (field) => [[id, field] as const] }),
  )
  return { fields, required: form.required ?? [] }
}

/** A field's choices, from `oneOf` or `enum` + `enumNames`. */
function fieldOptions(field: ElicitationField): ReadonlyArray<{ readonly value: string; readonly label: string | null }> {
  if (field.oneOf) return field.oneOf.map((option) => ({ value: option.const, label: option.title ?? null }))
  return (field.enum ?? []).map((value, index) => ({ value, label: field.enumNames?.[index] ?? null }))
}

/** Words that make an answer outlast this one request ("for this session", "always"). */
const PERSISTS = /session|always|permanent|forever|persistent/i
const ONE_TIME_ACCEPT = /^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$/i

/**
 * The value Docs fills in for the person, which they never see: the one-time "allow"
 * choice of an approval field, and `false` for a "remember this" checkbox.
 */
function implicitAnswer(id: string, field: ElicitationField): Json | undefined {
  const accept = fieldOptions(field).find((option) => ONE_TIME_ACCEPT.test(option.value.trim()) && !PERSISTS.test(option.value))
  if (accept) return accept.value
  const persistence = id.toLowerCase() === 'persist' || [id, field.title ?? '', field.description ?? ''].some((text) => PERSISTS.test(text))
  return field.type === 'boolean' && persistence ? false : undefined
}

/** The fields the person fills in; approval choices and persistence flags are answered for them. */
export function elicitationFields(params: ElicitationParams) {
  const visible = (formFields(params)?.fields ?? []).filter(([id, field]) => implicitAnswer(id, field) === undefined)
  return visible.map(([id, field]) => ({
    id,
    label: docsSafe(field.title) ?? docsSafe(id) ?? 'Answer',
    ...(field.default != null && typeof field.default !== 'object' ? { initial: String(field.default) } : {}),
  }))
}

/** What the person typed, as the field's JSON type or one of its choices; undefined when it is empty or doesn't fit. */
function typedAnswer(field: ElicitationField, text: string | undefined): Json | undefined {
  const value = text?.trim()
  if (!value) return field.default ?? undefined
  const options = fieldOptions(field)
  if (options.length) {
    const lower = value.toLowerCase()
    return options.find((option) => option.value.toLowerCase() === lower || option.label?.toLowerCase() === lower)?.value ?? field.default ?? undefined
  }
  if (field.type === 'boolean') return /^(true|yes|on|1)$/i.test(value) ? true : /^(false|no|off|0)$/i.test(value) ? false : undefined
  if (field.type === 'number' || field.type === 'integer') {
    const number = Number(value)
    return Number.isFinite(number) && (field.type === 'number' || Number.isInteger(number)) ? number : undefined
  }
  return value
}

/** The reply Codex expects: typed content, and a decline when a required field is missing. */
export function elicitationResponse(params: ElicitationParams, reply: ApprovalReply): ElicitationResponse {
  if (!reply.accept) return { action: 'cancel', content: null, _meta: null }
  const form = formFields(params)
  if (!form) return { action: 'accept', content: null, _meta: null }
  const content: Record<string, Json> = {}
  for (const [id, field] of form.fields) {
    const value = implicitAnswer(id, field) ?? typedAnswer(field, reply.answers[id])
    if (value !== undefined) content[id] = value
  }
  if (form.required.some((id) => !Object.hasOwn(content, id))) return { action: 'decline', content: null, _meta: null }
  return { action: 'accept', content, _meta: null }
}

function elicitationBlock(id: string, params: ElicitationParams): ApprovalBlock {
  const app = elicitationAppName(params)
  const text = params.mode === 'openai/userVerification' ? params.description || params.title : params.message
  return block(id, `Allow ${app}?`, docsSafe(text) ?? `${app} needs your OK to continue.`, {
    fields: elicitationFields(params),
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
    block: (id, params) => block(id, 'Edit files?', params.reason ?? 'Some files will change.'),
    response: (_params, reply) => ({ decision: reply.accept ? 'accept' : 'decline' }),
  },
  applyPatchApproval: {
    threadId: (params) => params.conversationId,
    block: (id, params) => block(id, 'Edit files?', params.reason ?? 'Some files will change.'),
    response: (_params, reply) => ({ decision: legacyDecision(reply) }),
  },
  'item/permissions/requestApproval': {
    threadId: (params) => params.threadId,
    block: (id, params) => block(id, 'Allow more access?', params.reason ?? 'More access is needed to continue.'),
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
    block: elicitationBlock,
    response: elicitationResponse,
    // A URL request would open a site before the person agreed to anything; T3 declines it too.
    answerAtOnce: (params) => (params.mode === 'url' ? { action: 'decline', content: null, _meta: null } : null),
  },
  'item/tool/requestUserInput': {
    threadId: (params) => params.threadId,
    block: (id, params) =>
      block(id, 'Input needed', params.questions.map((q) => q.question).filter(Boolean).join('\n') || 'Continue?', {
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
