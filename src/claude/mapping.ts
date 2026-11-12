import type {
  AccountInfo,
  ModelInfo,
  PermissionResult,
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SessionMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

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
    source: source && {
      type: asString(source.type),
      media_type: asString(source.media_type),
      data: asString(source.data),
    },
  }
}

/** A message's `id` and `content`, each read on its own. */
const decodeMessage = (value: unknown) => {
  const message = asRecord(value)
  return { id: asString(message?.id), content: asContent(message?.content) }
}

/** Each block of `content` that has a type; one malformed block never hides the rest. */
const blocksOf = (content: ReadonlyArray<unknown>): ContentBlock[] => content.flatMap((part) => decodeBlock(part) ?? [])

const COMMAND = /<command-name>\/?([^<]+)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
// Text the CLI adds to a user turn that the person never typed.
const INJECTED = /^(Base directory for this skill:|<system-reminder>|<local-command|Caveat: )/

/**
 * The session's name, when it has one: a custom title, or a summary Claude
 * wrote. The SDK's `summary` falls back to the first prompt, which is not a
 * name; a document without one reads "Untitled document" (Home still lists
 * its first line, from `preview`).
 */
export const sessionName = (info: SDKSessionInfo): string | null =>
  info.customTitle || (info.summary && info.summary !== info.firstPrompt ? info.summary : null)

export function toDoc(info: SDKSessionInfo): DocSummary {
  return {
    id: info.sessionId,
    name: sessionName(info),
    preview: info.firstPrompt || info.summary || 'Untitled document',
    updatedAt: Math.floor(info.lastModified / 1000),
    cwd: info.cwd ?? '',
    projectId: null,
  }
}

export const sessionTitle = (info: SDKSessionInfo | undefined) => (info && sessionName(info)) || 'Untitled document'

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

function toolTitle(name: string, done: boolean): string {
  if (name === 'Bash') return done ? 'Ran a command' : 'Running a command'
  return done ? `Used ${name}` : `Using ${name}`
}

function toolBody(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const main = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query
  return typeof main === 'string' ? main : JSON.stringify(input).slice(0, 400)
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return blocksOf(content)
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

const toolCallout = (part: ContentBlock): CalloutBlock => ({
  kind: 'callout',
  id: part.id ?? '',
  title: toolTitle(part.name ?? 'a tool', false),
  body: toolBody(part.input),
})

/** The callout once its tool finished, with the output under the command. */
function finishedCallout(callout: CalloutBlock, result: ContentBlock): CalloutBlock {
  const output = resultText(result.content).trim().slice(0, 2000)
  return {
    ...callout,
    title: callout.title.replace(/^Running/, 'Ran').replace(/^Using/, 'Used'),
    body: output ? `${callout.body}\n${output}` : callout.body,
  }
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
        const at = part.type === 'tool_result' && part.tool_use_id ? index.get(part.tool_use_id) : undefined
        const callout = at === undefined ? undefined : blocks[at]
        if (callout?.kind === 'callout') put(finishedCallout(callout, part))
      }
      const turn = userTurn(message.uuid, parts)
      if (turn) put(turn)
      continue
    }
    if (message.type !== 'assistant') continue
    const id = decodeMessage(message.message).id ?? message.uuid
    for (const part of parts) {
      if (part.type === 'tool_use' && part.id) put(toolCallout(part))
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
  readonly callouts: Map<string, CalloutBlock>
}

export const emptyStreamState = (): StreamState => ({
  messageId: null,
  streamed: new Set(),
  texts: new Map(),
  callouts: new Map(),
})

/** What one SDK frame changes on the page; the adapter adds the thread id. */
export type Emission =
  | { readonly type: 'block'; readonly block: Block }
  | { readonly type: 'text'; readonly blockId: string; readonly delta: string }
  | { readonly type: 'result'; readonly error: string | undefined }

/** Folds one live SDK frame into page changes. */
export function readMessage(state: StreamState, message: SDKMessage): Emission[] {
  if ('parent_tool_use_id' in message && message.parent_tool_use_id) return []
  switch (message.type) {
    case 'stream_event': {
      const event = message.event
      if (event.type === 'message_start') state.messageId = event.message.id
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
      const out: Emission[] = []
      for (const part of partsOf(message.message)) {
        if (part.type === 'tool_use' && part.id) {
          const callout = toolCallout(part)
          state.callouts.set(callout.id, callout)
          out.push({ type: 'block', block: callout })
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
        const callout =
          part.type === 'tool_result' && part.tool_use_id ? state.callouts.get(part.tool_use_id) : undefined
        if (!callout) continue
        state.callouts.delete(callout.id)
        out.push({ type: 'block', block: finishedCallout(callout, part) })
      }
      return out
    }
    case 'result':
      state.messageId = null
      state.streamed.clear()
      state.texts.clear()
      return [{ type: 'result', error: resultError(message) }]
    default:
      return []
  }
}

function append(state: StreamState, id: string, delta: string): Emission {
  state.texts.set(id, (state.texts.get(id) ?? '') + delta)
  return { type: 'text', blockId: id, delta }
}

const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: 'Claude stopped after reaching its step limit.',
  error_max_budget_usd: 'Claude stopped after reaching its spending limit.',
  error_max_structured_output_retries: 'Claude could not finish the answer.',
}

/**
 * The sentence to show when a turn failed, or nothing when it finished or was
 * stopped on purpose (the SDK reports aborts as errors or as `success`).
 * Adapted from T3 Code (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts, terminalStatusFromResult) at commit 8a14762c.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
export function resultError(message: SDKResultMessage): string | undefined {
  if (message.terminal_reason === 'aborted_tools' || message.terminal_reason === 'aborted_streaming') return undefined
  if (message.subtype === 'success')
    return message.is_error ? message.result.trim() || 'Claude ran into an error.' : undefined
  const text = message.errors.join('\n').trim()
  if (/interrupt|cancel/i.test(text)) return undefined
  return text || RESULT_ERRORS[message.subtype] || 'Claude stopped before finishing.'
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

export const permissionBlockId = (toolUseId: string) => `approval-${toolUseId}`

const MENTIONS_VENDOR = /claude|anthropic/i

/**
 * A short name for the tool, never the SDK's own sentences: its `title` and
 * `description` speak as the assistant ("Claude wants to search the web"),
 * which the page must never show. MCP tools drop their `mcp__server__` prefix,
 * since a server key such as `claude_ai_Notion` names the vendor too. Null when
 * even the final name mentions the vendor (`mcp__x__claude_search`).
 */
export function toolLabel(tool: string, displayName: string | undefined): string | null {
  if (displayName && !MENTIONS_VENDOR.test(displayName)) return displayName
  const mcp = /^mcp__.+?__(.+)$/.exec(tool)
  const label = mcp ? mcp[1]!.replace(/_/g, ' ') : tool
  return MENTIONS_VENDOR.test(label) ? null : label
}

const clip = (text: string) => (text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : text)

/** A tool Claude wants to run, as a suggestion card asking to allow it. */
export function permissionBlock(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  displayName: string | undefined,
): ApprovalBlock {
  const preview = PREVIEW_KEYS.map((key) => input[key]).find((value): value is string => typeof value === 'string')
  const label = toolLabel(tool, displayName)
  return {
    kind: 'approval',
    id,
    suggestion: 'add',
    title: label ? `Allow ${label}?` : 'Allow this tool?',
    body: preview ? clip(preview) : '',
    fields: [],
    questions: [],
    resolved: null,
  }
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
    title: 'Claude needs input',
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
