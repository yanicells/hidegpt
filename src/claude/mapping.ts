import type {
  AccountInfo,
  ModelInfo,
  PermissionResult,
  SDKAssistantMessageError,
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SessionMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { Failure, FailureClass, ToolKind } from '../provider/events'
import { failureOf } from '../provider/failure'
import { requestTitle, toolTitle } from '../provider/toolTitles'
import type { ApprovalBlock, Block, CalloutBlock, DocSummary, ModelOption, Skill, UserBlock } from '../shared/model'

/**
 * Pure mapping from the Claude Agent SDK's types to HideGPT's domain model:
 * saved transcripts and live frames to blocks, sessions to documents, models
 * and slash commands to the toolbar's menus. Thinking and subagent traffic
 * never reach the page.
 */

/**
 * The fields Docs reads from a Messages API content block; transcripts and stream
 * frames share it. Fields are decoded one by one, as the old loose reads were: a
 * field of an unexpected type is left out, and the block (and its siblings) still show.
 */
type ContentBlock = {
  readonly type: string
  readonly text?: string | undefined
  readonly id?: string | undefined
  readonly name?: string | undefined
  readonly input?: Readonly<Record<string, unknown>> | undefined
  readonly tool_use_id?: string | undefined
  readonly content?: unknown
  readonly is_error?: boolean | undefined
  readonly source?:
    | {
        readonly type?: string | undefined
        readonly media_type?: string | undefined
        readonly data?: string | undefined
      }
    | undefined
}

const field = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema)
  return (value: unknown): S['Type'] | undefined => Option.getOrUndefined(decode(value))
}
const asString = field(Schema.String)
const asRecord = field(Schema.Record(Schema.String, Schema.Unknown))
const asContent = field(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]))

function decodeBlock(value: unknown): ContentBlock | undefined {
  const part = asRecord(value)
  const type = asString(part?.type)
  if (!part || type === undefined) return undefined
  const source = asRecord(part.source)
  return {
    type,
    text: asString(part.text),
    id: asString(part.id),
    name: asString(part.name),
    input: asRecord(part.input),
    tool_use_id: asString(part.tool_use_id),
    content: part.content,
    is_error: part.is_error === true,
    source: source && {
      type: asString(source.type),
      media_type: asString(source.media_type),
      data: asString(source.data),
    },
  }
}

/** A message's `id`, `model` and `content`, each read on its own. */
const decodeMessage = (value: unknown) => {
  const message = asRecord(value)
  return { id: asString(message?.id), model: asString(message?.model), content: asContent(message?.content) }
}

/**
 * Claude Code writes its own notices (a usage limit, "Please run /login", an API
 * error) as assistant messages from this model. They are never document text.
 */
const SYNTHETIC_MODEL = '<synthetic>'

/** Each block of `content` that has a type; one malformed block never hides the rest. */
const blocksOf = (content: ReadonlyArray<unknown>): ContentBlock[] => content.flatMap((part) => decodeBlock(part) ?? [])

const COMMAND = /<command-name>\/?([^<]+)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
// Text the CLI adds to a user turn that the person never typed.
const INJECTED = /^(Base directory for this skill:|<system-reminder>|<local-command|Caveat: )/

export function toDoc(info: SDKSessionInfo): DocSummary {
  const title = info.customTitle || info.summary || info.firstPrompt || null
  return {
    id: info.sessionId,
    name: title,
    preview: info.firstPrompt || title || 'Untitled document',
    updatedAt: Math.floor(info.lastModified / 1000),
    cwd: info.cwd ?? '',
    projectId: null,
  }
}

export const sessionTitle = (info: SDKSessionInfo | undefined) =>
  (info && (info.customTitle || info.summary || info.firstPrompt)) || 'Untitled document'

export function toModels(models: ReadonlyArray<ModelInfo>): ModelOption[] {
  return models.map((model) => {
    const efforts = model.supportsEffort === false ? [] : [...(model.supportedEffortLevels ?? [])]
    return {
      id: model.value,
      label: model.displayName || model.value,
      efforts,
      defaultEffort: efforts.includes('high') ? 'high' : (efforts[0] ?? null),
      serviceTiers: [],
      isDefault: model.value === 'default',
    }
  })
}

/** User-defined skills and commands; Claude Code's own built-ins stay out of the menu. */
export function toSkills(commands: ReadonlyArray<SlashCommand>): Skill[] {
  return commands
    .filter((command) => !command.builtin)
    .map((command) => ({ name: command.name, description: command.description, path: '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Whether Claude Code has a usable login. Startup alone proves nothing; only
 * `tokenSource: "none"` with no key or account disproves it.
 * Adapted from T3 Code (apps/server/src/provider/ClaudeProvider.ts) at commit 8a14762c.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
export function isSignedIn(account: AccountInfo | undefined): boolean {
  if (!account) return false
  if (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') return true
  if (account.tokenSource !== undefined && account.tokenSource !== 'none') return true
  const hasKey = Boolean(account.apiKeySource) && account.apiKeySource !== 'none'
  return hasKey || Boolean(account.email) || Boolean(account.subscriptionType)
}

function partsOf(message: unknown): ContentBlock[] {
  const content = decodeMessage(message).content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content ? blocksOf(content) : []
}

// The input field that best shows what a tool will touch, first match wins. A Task's
// short `description` comes before its `prompt`, which is the whole subagent brief.
const PREVIEW_KEYS = [
  'command',
  'file_path',
  'notebook_path',
  'path',
  'url',
  'query',
  'pattern',
  'description',
  'prompt',
] as const
/** A card shows a glimpse of the input, not all of it. */
const PREVIEW_MAX = 200

const clip = (text: string) => (text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : text)

const firstString = (input: Record<string, unknown>, keys: ReadonlyArray<string>) =>
  keys.map((key) => input[key]).find((value): value is string => typeof value === 'string')

/**
 * Claude Code's tools by kind; `null` draws no callout (bookkeeping tools, and the
 * question and plan tools, whose card already shows them).
 * Adapted from T3 Code (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts,
 * CLAUDE_KNOWN_TOOL_CLASSIFICATIONS) at commit 5c6f2f12.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
const TOOL_KINDS = new Map<string, ToolKind | null>([
  ['bash', 'command'],
  ['edit', 'file_change'],
  ['multiedit', 'file_change'],
  ['write', 'file_change'],
  ['notebookedit', 'file_change'],
  ['read', 'file_read'],
  ['glob', 'file_search'],
  ['grep', 'file_search'],
  ['ls', 'file_search'],
  ['websearch', 'web_search'],
  ['webfetch', 'web_fetch'],
  ['agent', 'subagent'],
  ['task', 'subagent'],
  ['todowrite', null],
  ['taskstop', null],
  ['toolsearch', null],
  ['sendmessage', null],
  ['monitor', null],
  ['askuserquestion', null],
  ['exitplanmode', null],
])

/** The kind of step a tool call is, or null when it draws no callout. */
function toolKind(name: string): ToolKind | null {
  if (name.startsWith('mcp__')) return 'mcp_tool'
  const kind = TOOL_KINDS.get(name.toLowerCase().replace(/[\s_-]/g, ''))
  return kind === undefined ? 'other' : kind
}

/** What the step touched: one input field, never the input as JSON, and never a subagent's brief. */
function toolBody(kind: ToolKind, input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const value = firstString(input, kind === 'subagent' ? ['description'] : PREVIEW_KEYS)
  if (value === undefined) return ''
  return kind === 'subagent' || kind === 'mcp_tool' || kind === 'other' ? clip(value) : value
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return blocksOf(content)
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** A tool call on the page: its callout, and the kind and name that decide how it finishes. */
type ToolCall = { readonly block: CalloutBlock; readonly kind: ToolKind; readonly name: string }

/** A running tool's callout, or null for a tool the page does not show. */
function toolCall(part: ContentBlock): ToolCall | null {
  const name = part.name ?? ''
  const kind = toolKind(name)
  if (!kind) return null
  const block: CalloutBlock = {
    kind: 'callout',
    id: part.id ?? '',
    title: toolTitle(kind, 'running', name),
    body: toolBody(kind, part.input),
  }
  return { block, kind, name }
}

/**
 * The callout once its tool finished, with the output under the command. A
 * subtask's output is its whole report (with Claude Code's own continuation
 * notes), so it keeps only its description. A failed tool says so in Docs'
 * words and never shows its error text.
 */
function finishedCallout({ block, kind, name }: ToolCall, result: ContentBlock): CalloutBlock {
  if (result.is_error) return { ...block, title: toolTitle(kind, 'failed', name) }
  const output = kind === 'subagent' ? '' : resultText(result.content).trim().slice(0, 2000)
  const title = toolTitle(kind, 'completed', name)
  return { ...block, title, body: output ? `${block.body}\n${output}` : block.body }
}

/** A person's turn: typed text, pasted images, and any skill invoked with /name. */
function userTurn(id: string, parts: ReadonlyArray<ContentBlock>): UserBlock | null {
  const text: string[] = []
  const images: string[] = []
  const skills: string[] = []
  for (const part of parts) {
    if (part.type === 'image' && part.source?.type === 'base64') {
      images.push(`data:${part.source.media_type};base64,${part.source.data}`)
    }
    if (part.type !== 'text' || !part.text || INJECTED.test(part.text)) continue
    const command = COMMAND.exec(part.text)?.[1]
    if (command) {
      skills.push(command.trim())
      text.push(COMMAND_ARGS.exec(part.text)?.[1]?.trim() ?? '')
    } else if (!part.text.includes('<command-message>')) {
      text.push(part.text)
    }
  }
  const joined = text.filter(Boolean).join('\n')
  if (!joined && !images.length && !skills.length) return null
  return { kind: 'user', id, text: joined, ...(images.length ? { images } : {}), ...(skills.length ? { skills } : {}) }
}

/** Rebuilds a document from a saved transcript. */
export function blocksFromSessionMessages(messages: ReadonlyArray<SessionMessage>): Block[] {
  const blocks: Block[] = []
  const index = new Map<string, number>()
  const calls = new Map<string, ToolCall>()
  const put = (block: Block) => {
    const at = index.get(block.id)
    if (at === undefined) {
      index.set(block.id, blocks.length)
      blocks.push(block)
    } else blocks[at] = block
  }
  for (const message of messages) {
    if (message.parent_tool_use_id) continue
    const parts = partsOf(message.message)
    if (message.type === 'user') {
      for (const part of parts) {
        const call = part.type === 'tool_result' && part.tool_use_id ? calls.get(part.tool_use_id) : undefined
        if (call) put(finishedCallout(call, part))
      }
      const turn = userTurn(message.uuid, parts)
      if (turn) put(turn)
      continue
    }
    if (message.type !== 'assistant') continue
    const decoded = decodeMessage(message.message)
    if (decoded.model === SYNTHETIC_MODEL) continue
    const id = decoded.id ?? message.uuid
    for (const part of parts) {
      const call = part.type === 'tool_use' && part.id ? toolCall(part) : null
      if (call) {
        calls.set(call.block.id, call)
        put(call.block)
      }
      if (part.type === 'text' && part.text) {
        const at = index.get(id)
        const current = at === undefined ? undefined : blocks[at]
        put(
          current?.kind === 'agent'
            ? { ...current, text: `${current.text}\n\n${part.text}` }
            : { kind: 'agent', id, text: part.text },
        )
      }
    }
  }
  return blocks
}

/** Live-stream bookkeeping for one query. */
export type StreamState = {
  /** The assistant message the next text delta belongs to. */
  messageId: string | null
  /** Messages whose text arrived as deltas, so the final frame is not drawn twice. */
  readonly streamed: Set<string>
  readonly texts: Map<string, string>
  readonly callouts: Map<string, ToolCall>
  /** The error of the turn's last Claude Code notice, which classes the turn's failure. */
  notice: SDKAssistantMessageError | null
}

export const emptyStreamState = (): StreamState => ({
  messageId: null,
  streamed: new Set(),
  texts: new Map(),
  callouts: new Map(),
  notice: null,
})

/** What one SDK frame changes on the page; the adapter adds the thread id. */
export type Emission =
  | { readonly type: 'block'; readonly block: Block }
  | { readonly type: 'text'; readonly blockId: string; readonly delta: string }
  | { readonly type: 'result'; readonly failure: Failure | undefined }

/** Folds one live SDK frame into page changes. */
export function readMessage(state: StreamState, message: SDKMessage): Emission[] {
  if ('parent_tool_use_id' in message && message.parent_tool_use_id) return []
  switch (message.type) {
    case 'stream_event': {
      const event = message.event
      // A Claude Code notice never streams onto the page; its final frame classes the turn.
      if (event.type === 'message_start')
        state.messageId = event.message.model === SYNTHETIC_MODEL ? null : event.message.id
      const id = state.messageId
      if (!id) return []
      if (event.type === 'content_block_start' && event.content_block.type === 'text' && state.texts.get(id)) {
        return [append(state, id, '\n\n')]
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
        state.streamed.add(id)
        return [append(state, id, event.delta.text)]
      }
      return []
    }
    case 'assistant': {
      const id = message.message.id
      if (message.message.model === SYNTHETIC_MODEL) {
        // Kept as data for the result, never drawn.
        state.notice = message.error ?? state.notice
        return []
      }
      const out: Emission[] = []
      for (const part of partsOf(message.message)) {
        const call = part.type === 'tool_use' && part.id ? toolCall(part) : null
        if (call) {
          state.callouts.set(call.block.id, call)
          out.push({ type: 'block', block: call.block })
        }
        // With partial messages on, the deltas already drew this text.
        if (part.type === 'text' && part.text && !state.streamed.has(id)) {
          const previous = state.texts.get(id)
          const text = previous ? `${previous}\n\n${part.text}` : part.text
          state.texts.set(id, text)
          out.push({ type: 'block', block: { kind: 'agent', id, text } })
        }
      }
      return out
    }
    case 'user': {
      const out: Emission[] = []
      for (const part of partsOf(message.message)) {
        const call = part.type === 'tool_result' && part.tool_use_id ? state.callouts.get(part.tool_use_id) : undefined
        if (!call) continue
        state.callouts.delete(call.block.id)
        out.push({ type: 'block', block: finishedCallout(call, part) })
      }
      return out
    }
    case 'result': {
      const failure = resultError(message, state.notice)
      state.messageId = null
      state.streamed.clear()
      state.texts.clear()
      state.notice = null
      return [{ type: 'result', failure }]
    }
    default:
      return []
  }
}

function append(state: StreamState, id: string, delta: string): Emission {
  state.texts.set(id, (state.texts.get(id) ?? '') + delta)
  return { type: 'text', blockId: id, delta }
}

const AUTH_ERRORS = new Set<SDKAssistantMessageError>([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
])
const PROVIDER_ERRORS = new Set<SDKAssistantMessageError>(['overloaded', 'server_error'])
const VALIDATION_ERRORS = new Set<SDKAssistantMessageError>(['invalid_request', 'model_not_found', 'max_output_tokens'])

/** The failure class from the turn's notice, the API status and the terminal reason. */
function classOf(message: SDKResultMessage, notice: SDKAssistantMessageError | null): FailureClass {
  const status = message.subtype === 'success' ? (message.api_error_status ?? undefined) : undefined
  const reason = message.terminal_reason
  if (notice === 'rate_limit' || status === 429 || message.subtype === 'error_max_budget_usd') return 'usage_limit'
  if ((notice && AUTH_ERRORS.has(notice)) || status === 401 || status === 403) return 'auth'
  if ((notice && PROVIDER_ERRORS.has(notice)) || (status !== undefined && status >= 500)) return 'provider_error'
  if (reason === 'api_error' || reason === 'model_error') return 'provider_error'
  // Without rate-limit evidence (above), `blocking_limit` means the context is full.
  if (notice && VALIDATION_ERRORS.has(notice)) return 'validation_error'
  if (reason === 'prompt_too_long' || reason === 'image_error' || reason === 'blocking_limit') return 'validation_error'
  return 'unknown'
}

/** The error text without Claude Code's internal telemetry lines. */
const withoutDiagnostics = (texts: ReadonlyArray<string>) =>
  texts
    .flatMap((text) => text.split('\n'))
    .filter((line) => !line.startsWith('[ede_diagnostic]'))
    .join('\n')
    .trim()

/**
 * Why a turn failed, or nothing when it finished or was stopped on purpose (the
 * SDK reports aborts as errors or as `success`). The provider's text is only the
 * failure's `detail` (redacted and bounded), for the log; the page shows the class's own sentence.
 * `notice` is the error of a Claude Code notice seen during the turn.
 * Adapted from T3 Code (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts, terminalStatusFromResult
 * and resultUserFacingError) at commit 5c6f2f12.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
export function resultError(
  message: SDKResultMessage,
  notice: SDKAssistantMessageError | null = null,
): Failure | undefined {
  if (message.terminal_reason === 'aborted_tools' || message.terminal_reason === 'aborted_streaming') return undefined
  if (message.subtype === 'success') {
    return message.is_error ? failureOf(classOf(message, notice), withoutDiagnostics([message.result])) : undefined
  }
  const text = withoutDiagnostics(message.errors)
  if (/interrupt|cancel/i.test(text)) return undefined
  return failureOf(classOf(message, notice), text || message.subtype)
}

export const permissionBlockId = (toolUseId: string) => `approval-${toolUseId}`

/**
 * A tool Claude wants to run, as a suggestion card asking by the tool's kind
 * (never its name, or the SDK's `title` and `displayName`, which can name the
 * vendor or another product). The plan tool's card shows the whole plan, since
 * that is what the person approves.
 */
export function permissionBlock(id: string, tool: string, input: Record<string, unknown>): ApprovalBlock {
  const card = { kind: 'approval', id, suggestion: 'add', fields: [], questions: [], resolved: null } as const
  if (tool === 'ExitPlanMode') {
    return { ...card, title: 'Review the plan?', body: typeof input.plan === 'string' ? input.plan : '' }
  }
  // The same one field a callout shows, so a subtask's card shows its description, never its brief.
  const kind = toolKind(tool) ?? 'other'
  return { ...card, title: requestTitle(kind, tool), body: clip(toolBody(kind, input)) }
}

export type AskedQuestion = {
  readonly question: string
  readonly header: string
  readonly options: ReadonlyArray<{ readonly label: string }>
}

const AskedItem = Schema.Struct({
  question: Schema.String,
  header: Schema.optionalKey(Schema.Unknown),
  options: Schema.optionalKey(Schema.Unknown),
})
const decodeAskedItem = Schema.decodeUnknownOption(AskedItem)
const decodeOption = Schema.decodeUnknownOption(Schema.Struct({ label: Schema.String }))

/** The questions of an `AskUserQuestion` call, or null when its input is not that shape. */
export function askedQuestions(input: Record<string, unknown>): AskedQuestion[] | null {
  const questions = input.questions
  if (!Array.isArray(questions)) return null
  return questions.flatMap((item: unknown) =>
    Option.toArray(decodeAskedItem(item)).map((value) => ({
      question: value.question,
      header: typeof value.header === 'string' ? value.header : '',
      options: Array.isArray(value.options)
        ? value.options.flatMap((option: unknown) =>
            Option.toArray(decodeOption(option)).map(({ label }) => ({ label })),
          )
        : [],
    })),
  )
}

export const questionId = (index: number) => `q${index}`

export function questionBlock(id: string, questions: ReadonlyArray<AskedQuestion>): ApprovalBlock {
  return {
    kind: 'approval',
    id,
    suggestion: 'question',
    title: 'Needs your reply',
    body: questions.map((item) => item.question).join('\n') || 'Continue?',
    fields: [],
    // Claude adds its own "Other" choice, so free text is always allowed.
    questions: questions.map((item, index) => ({
      id: questionId(index),
      question: item.question || item.header,
      options: item.options.map((option) => option.label),
      allowText: true,
    })),
    resolved: null,
  }
}

/** `AskUserQuestion` takes answers keyed by the question text. */
export function questionAnswers(
  input: Record<string, unknown>,
  questions: ReadonlyArray<AskedQuestion>,
  answers: Readonly<Record<string, string>>,
): PermissionResult {
  const byQuestion = Object.fromEntries(
    questions.flatMap((item, index) => {
      const answer = answers[questionId(index)]?.trim()
      return answer ? [[item.question, answer]] : []
    }),
  )
  return { behavior: 'allow', updatedInput: { ...input, answers: byQuestion } }
}
