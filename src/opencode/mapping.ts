import { readFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'

import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type {
  Agent,
  FilePartInput,
  GlobalSession,
  Message,
  Part,
  PermissionRequest,
  Project,
  Provider,
  QuestionRequest,
  TextPartInput,
  ToolPart,
} from '@opencode-ai/sdk/v2/client'

import { requestTitle, toolTitle } from '../provider/toolTitles'
import type { Failure, FailureClass, ToolKind } from '../provider/events'
import { failureOf } from '../provider/failure'
import type {
  ApprovalBlock,
  Block,
  CalloutBlock,
  DocSummary,
  ModelOption,
  ModeOption,
  ProjectSummary,
  UserBlock,
} from '../shared/model'

/**
 * Pure mapping from OpenCode's SDK types to HideGPT's domain model: messages
 * to blocks, sessions to documents, providers to models, pending requests to
 * approval blocks. No I/O except reading an attached image or skill file.
 */

export type MessageWithParts = { readonly info: Message; readonly parts: ReadonlyArray<Part> }

/** `providerID/modelID`, the id the toolbar shows and sends back. */
export const modelKey = (providerID: string, modelID: string) => `${providerID}/${modelID}`

export function splitModelKey(id: string): { providerID: string; modelID: string } | null {
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) return null
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}

export function toModels(
  providers: ReadonlyArray<Provider>,
  defaults: Readonly<Record<string, string>>,
): ModelOption[] {
  const models: ModelOption[] = []
  for (const provider of providers) {
    for (const [id, model] of Object.entries(provider.models)) {
      models.push({
        id: modelKey(provider.id, id),
        label: model.name || id,
        efforts: [],
        defaultEffort: null,
        serviceTiers: [],
        isDefault: false,
      })
    }
  }
  const preferred = Object.entries(defaults)
    .map(([provider, model]) => modelKey(provider, model))
    .find((key) => models.some((model) => model.id === key))
  return models.map((model) => (model.id === preferred ? { ...model, isDefault: true } : model))
}

/** Primary agents the person can pick; subagents and the read-only planner stay hidden. */
export function toModes(agents: ReadonlyArray<Agent>): ModeOption[] {
  return agents
    .filter((agent) => agent.mode !== 'subagent' && agent.name.toLowerCase() !== 'plan')
    .map((agent) => ({ id: agent.name, label: agent.name }))
}

export const defaultMode = (modes: ReadonlyArray<ModeOption>): string | null =>
  modes.find((mode) => mode.id === 'build')?.id ?? modes[0]?.id ?? null

/**
 * Projects carry no display name of their own, only a hash id and a worktree
 * path, so folders are named after their directory. The `global` project
 * (worktree `/`) is skipped so its sessions list as loose documents.
 */
export function toProjects(projects: ReadonlyArray<Project>): ProjectSummary[] {
  return projects.flatMap((project) => {
    const folder = project.worktree.replace(/\/+$/, '').split('/').pop()
    if (project.id === 'global' || !folder) return []
    return [{ id: project.id, name: project.name || folder, roots: [{ path: project.worktree }] }]
  })
}

export function toDoc(session: GlobalSession): DocSummary {
  const updated = session.time.updated || session.time.created
  return {
    id: session.id,
    name: session.title || null,
    preview: session.title || 'Untitled document',
    updatedAt: Math.floor(updated / 1000),
    cwd: session.directory,
    projectId: session.projectID === 'global' ? null : session.projectID || null,
  }
}

const visibleText = (part: Part): part is Extract<Part, { type: 'text' }> =>
  part.type === 'text' && !part.synthetic && !part.ignored

export function messageText(parts: ReadonlyArray<Part>, separator: string): string {
  return parts
    .filter(visibleText)
    .map((part) => part.text)
    .filter(Boolean)
    .join(separator)
}

/** Agent text is its visible text parts joined like paragraphs; reasoning never shows. */
export const joinAgentText = (texts: Iterable<string>) => [...texts].filter(Boolean).join('\n\n')

const SKILL_TAG = /^<skill_content name="([^"]+)">/

export function userBlock(id: string, parts: ReadonlyArray<Part>): UserBlock | null {
  const images: string[] = []
  const skills: string[] = []
  for (const part of parts) {
    if (part.type === 'file' && part.mime.startsWith('image/')) images.push(part.url)
    const skill = part.type === 'text' && part.synthetic ? SKILL_TAG.exec(part.text)?.[1] : undefined
    if (skill) skills.push(skill)
  }
  const text = messageText(parts, '\n')
  if (!text && !images.length && !skills.length) return null
  return { kind: 'user', id, text, ...(images.length ? { images } : {}), ...(skills.length ? { skills } : {}) }
}

/**
 * OpenCode's built-in tools by kind; null draws no callout (the question tool, whose
 * card shows it, and the to-do list). Kinds follow T3 Code
 * (packages/provider-opencode/src/server/toolItems.ts, openCodeToolProjectionKind) at commit 5c6f2f12.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
const BUILT_IN_TOOLS = new Map<string, ToolKind | null>([
  ['bash', 'command'],
  ['edit', 'file_change'],
  ['write', 'file_change'],
  ['patch', 'file_change'],
  ['apply_patch', 'file_change'],
  ['multiedit', 'file_change'],
  ['read', 'file_read'],
  ['glob', 'file_search'],
  ['grep', 'file_search'],
  ['list', 'file_search'],
  ['lsp', 'file_search'],
  ['webfetch', 'web_fetch'],
  ['websearch', 'web_search'],
  ['codesearch', 'web_search'],
  ['task', 'subagent'],
  ['question', null],
  ['todowrite', null],
  ['todoread', null],
])

/**
 * The kind of step a tool part is, or null when it draws no callout. OpenCode names a
 * connected app's tool `{server}_{tool}` (`notion_search`), so any other name with an
 * underscore is one.
 */
function toolKind(name: string): ToolKind | null {
  const normalized = name.toLowerCase()
  const builtIn = BUILT_IN_TOOLS.get(normalized)
  if (builtIn !== undefined) return builtIn
  return normalized.startsWith('mcp__') || normalized.includes('_') ? 'mcp_tool' : 'other'
}

/**
 * A `read` result without OpenCode's `<path>…<type>…<content>` envelope.
 * Adapted from T3 Code (packages/provider-opencode/src/server/toolItems.ts, nativeReadOutput) at commit 5c6f2f12.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
function readOutput(output: string): string {
  const header = /^<path>[^\r\n]+<\/path>\r?\n<type>(directory|file)<\/type>\r?\n/.exec(output)
  if (header === null) return output
  const body = output.slice(header[0].length)
  // File lines are numbered; only a closing tag on its own line ends the envelope.
  const envelope =
    header[1] === 'directory'
      ? /^<entries>\r?\n([\s\S]*?)\r?\n<\/entries>(?=\r?\n|$)/.exec(body)
      : /^<content>(?:\r?\n)?([\s\S]*?)\r?\n<\/content>(?=\r?\n|$)/.exec(body)
  // OpenCode can append instructions after the envelope; keep that suffix verbatim.
  return envelope === null ? output : envelope[1] + body.slice(envelope[0].length)
}

/**
 * A tool part as a callout, or null for a tool the page does not show. A pending or
 * running step says so and shows nothing yet; a finished one shows its output, and a
 * failed one says so, never with the tool's own error text.
 */
export function toolCallout(part: ToolPart): CalloutBlock | null {
  const kind = toolKind(part.tool)
  if (!kind) return null
  const state = part.state
  const status = state.status === 'completed' ? 'completed' : state.status === 'error' ? 'failed' : 'running'
  // A subtask's output is its whole report, with OpenCode's `<task_metadata>` session id.
  const output =
    state.status !== 'completed' || kind === 'subagent'
      ? ''
      : kind === 'file_read'
        ? readOutput(state.output)
        : state.output
  return { kind: 'callout', id: part.id, title: toolTitle(kind, status, part.tool), body: output.slice(0, 2000) }
}

export function blocksFromMessages(messages: ReadonlyArray<MessageWithParts>): Block[] {
  const blocks: Block[] = []
  for (const message of messages) {
    if (message.info.role === 'user') {
      const block = userBlock(message.info.id, message.parts)
      if (block) blocks.push(block)
      continue
    }
    const text = messageText(message.parts, '\n\n')
    if (text) blocks.push({ kind: 'agent', id: message.info.id, text })
    for (const part of message.parts) {
      const callout = part.type === 'tool' ? toolCallout(part) : null
      if (callout) blocks.push(callout)
    }
  }
  return blocks
}

export function sessionTitle(title: string | undefined, messages: ReadonlyArray<MessageWithParts>): string {
  if (title?.trim()) return title.trim()
  const firstUser = messages.find((message) => message.info.role === 'user')
  const text = firstUser ? messageText(firstUser.parts, '\n') : ''
  return text.split('\n')[0]?.trim() || 'Untitled document'
}

export const permissionBlockId = (requestId: string) => `approval-${requestId}`

/**
 * The kind of step an OpenCode permission asks for, so its card asks in the same
 * words as a Claude one (`requestTitle`); never the permission's own name.
 * Adapted from T3 Code (packages/provider-opencode/src/server/adapter.ts, openCodePermissionRequestKind)
 * at commit 5c6f2f12.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
function permissionKind(permission: string): ToolKind {
  const normalized = permission.toLowerCase()
  if (['edit', 'write', 'patch', 'apply_patch'].includes(normalized)) return 'file_change'
  if (['read', 'glob', 'grep', 'list', 'lsp', 'external_directory'].includes(normalized)) return 'file_read'
  if (normalized === 'bash') return 'command'
  if (normalized === 'webfetch' || normalized === 'websearch' || normalized === 'codesearch') return 'web_search'
  return 'other'
}

/** A permission the server asks for, as a suggestion card that quotes what it would touch. */
export function permissionBlock(request: PermissionRequest): ApprovalBlock {
  return {
    kind: 'approval',
    id: permissionBlockId(request.id),
    suggestion: 'add',
    title: requestTitle(permissionKind(request.permission)),
    body: request.patterns.join(', '),
    fields: [],
    questions: [],
    resolved: null,
  }
}

export const questionId = (index: number) => `q${index}`

export function questionBlock(request: QuestionRequest): ApprovalBlock {
  return {
    kind: 'approval',
    id: permissionBlockId(request.id),
    suggestion: 'question',
    title: 'Needs your reply',
    body:
      request.questions
        .map((question) => question.question)
        .filter(Boolean)
        .join('\n') || 'Continue?',
    fields: [],
    questions: request.questions.map((question, index) => ({
      id: questionId(index),
      question: question.question || question.header,
      options: question.options.map((option) => option.label),
      allowText: question.options.length === 0 || question.custom !== false,
    })),
    resolved: null,
  }
}

/**
 * A hidden prompt part carrying a skill's instructions, mirroring how Codex
 * injects skills. Synthetic parts never render, but the name is read back so
 * the page can still show which skill a question used.
 */
export function skillPart(skill: { name: string; location: string; content: string }): TextPartInput {
  const base = skill.location.startsWith('/') ? `Base directory for this skill: ${dirname(skill.location)}\n\n` : ''
  return {
    type: 'text',
    synthetic: true,
    text: `<skill_content name="${skill.name}">\nThe user attached the "${skill.name}" skill to this message. Follow it.\n\n${base}${skill.content}\n</skill_content>`,
  }
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** Inlines a saved image as a data URL so the server needs no file access. */
export function imagePart(path: string): FilePartInput {
  const mime = IMAGE_TYPES[extname(path).toLowerCase()] ?? 'image/png'
  return {
    type: 'file',
    mime,
    filename: basename(path),
    url: `data:${mime};base64,${readFileSync(path).toString('base64')}`,
  }
}

/** The fields of an OpenCode session error's `data` that Docs reads. */
const ProviderErrorData = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  statusCode: Schema.optionalKey(Schema.Number),
  responseBody: Schema.optionalKey(Schema.String),
})
const decodeProviderErrorData = Schema.decodeUnknownOption(ProviderErrorData)

type ProviderErrorPayload = { readonly name: string; readonly data?: unknown } | undefined

const errorData = (error: ProviderErrorPayload) =>
  Option.getOrElse(decodeProviderErrorData(error?.data), (): typeof ProviderErrorData.Type => ({}))

/**
 * The model provider's error as one line, for the log only: it can name the vendor
 * and carry URLs (OpenCode stores `<none>` when it could not read the provider's body).
 * Adapted from T3 Code (packages/provider-opencode/src/server/providerErrorMessage.ts) at commit 8a14762c.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
function readableProviderError(error: ProviderErrorPayload): string {
  if (!error) return 'No error was given.'
  const data = errorData(error)
  const message = data.message?.trim() ?? ''
  if (message && message.toLowerCase() !== '<none>') return message
  const status = data.statusCode
  const title = data.responseBody
    ?.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim()
  if (title) return status !== undefined ? `${title} (HTTP ${status}).` : title
  if (status !== undefined) return `The request failed (HTTP ${status}).`
  return message ? 'The request failed with no error message.' : error.name
}

/**
 * The class of a session error, from its name and HTTP status: a 429 is a usage
 * limit, as in T3 Code (packages/provider-opencode/src/server/adapter.ts, `session.error`).
 */
function providerFailureClass(error: ProviderErrorPayload): FailureClass {
  if (!error) return 'unknown'
  const status = errorData(error).statusCode
  if (error.name === 'ProviderAuthError' || status === 401 || status === 403) return 'auth'
  if (status === 429) return 'usage_limit'
  if (error.name === 'APIError' || (status !== undefined && status >= 500)) return 'provider_error'
  if (error.name === 'ContextOverflowError' || error.name === 'MessageOutputLengthError') return 'validation_error'
  return 'unknown'
}

/** Why a session failed: a class Docs words itself, with the provider's text (redacted) for the log. */
export const providerFailure = (error: ProviderErrorPayload): Failure =>
  failureOf(providerFailureClass(error), readableProviderError(error))
