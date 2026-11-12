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

export function toolCallout(part: ToolPart): CalloutBlock {
  const state = part.state
  const body =
    state.status === 'completed' ? state.output.slice(0, 2000) : state.status === 'error' ? state.error : state.status
  return { kind: 'callout', id: part.id, title: `Ran ${part.tool}`, body }
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
      if (part.type === 'tool') blocks.push(toolCallout(part))
    }
  }
  return blocks
}

/** The session's title; never its first message, which reads as what was asked. */
export const sessionTitle = (title: string | undefined): string => title?.trim() || 'Untitled document'

export const permissionBlockId = (requestId: string) => `approval-${requestId}`

export function permissionBlock(request: PermissionRequest): ApprovalBlock {
  const patterns = request.patterns.length ? `: ${request.patterns.join(', ')}` : ''
  return {
    kind: 'approval',
    id: permissionBlockId(request.id),
    suggestion: 'format',
    title: `Allow ${request.permission}${patterns}?`,
    body: 'The assistant is asking for extra access.',
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
    title: 'The assistant needs input',
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

/** The fields of an OpenCode session error's `data` that the sentence uses. */
const ProviderErrorData = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  statusCode: Schema.optionalKey(Schema.Number),
  responseBody: Schema.optionalKey(Schema.String),
})
const decodeProviderErrorData = Schema.decodeUnknownOption(ProviderErrorData)

/**
 * The model provider's error as one sentence (OpenCode stores `<none>` when it
 * could not read the provider's body).
 * Adapted from T3 Code (packages/provider-opencode/src/server/providerErrorMessage.ts) at commit 8a14762c.
 * Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
 */
export function readableProviderError(error: { name: string; data?: unknown } | undefined): string {
  if (!error) return 'The assistant ran into an error.'
  const data = Option.getOrElse(decodeProviderErrorData(error.data), (): typeof ProviderErrorData.Type => ({}))
  const message = data.message?.trim() ?? ''
  if (message && message.toLowerCase() !== '<none>') return message
  const status = data.statusCode
  const body = data.responseBody
  const title = body
    ?.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim()
  if (title) return status !== undefined ? `${title} (HTTP ${status}).` : title
  if (status !== undefined) return `The model provider failed the request (HTTP ${status}).`
  return message ? 'The model provider failed the request and did not include an error message.' : error.name
}
