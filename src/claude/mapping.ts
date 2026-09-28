import type {
  ModelInfo,
  SDKMessage,
  SDKSessionInfo,
  SessionMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'

import type { Model } from '../generated/codex/v2/Model'
import type { Thread } from '../generated/codex/v2/Thread'

import { upsertAgentDelta, type Block, type UserBlock } from '../codex/blocks'
import type { Skill } from '../codex/types'

/** Loose Messages API content block; transcripts and stream frames share it. */
type ContentBlock = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  source?: { type?: string; media_type?: string; data?: string }
}
type ApiMessage = { id?: string; content?: string | ContentBlock[] }

const COMMAND = /<command-name>\/?([^<]+)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
// Text the CLI adds to a user turn that the person never typed.
const INJECTED = /^(Base directory for this skill:|<system-reminder>|<local-command|Caveat: )/

export function toThread(info: SDKSessionInfo): Thread {
  const updated = Math.floor(info.lastModified / 1000)
  const title = info.customTitle || info.summary || info.firstPrompt || 'Untitled document'
  return {
    id: info.sessionId,
    extra: null,
    sessionId: info.sessionId,
    forkedFromId: null,
    parentThreadId: null,
    preview: info.firstPrompt || title,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'legacy',
    modelProvider: 'anthropic',
    model: null,
    reasoningEffort: null,
    createdAt: Math.floor((info.createdAt ?? info.lastModified) / 1000),
    updatedAt: updated,
    recencyAt: updated,
    status: { type: 'notLoaded' },
    path: null,
    cwd: info.cwd ?? '',
    cliVersion: '0',
    source: 'appServer',
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: title,
    turns: [],
  }
}

export function toModel(info: ModelInfo): Model {
  return {
    id: info.value,
    model: info.value,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: info.displayName,
    description: info.description,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: (info.supportedEffortLevels ?? []).map((level) => ({
      reasoningEffort: level,
      description: level,
    })),
    defaultReasoningEffort: 'high',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: info.value === 'default',
  }
}

/** User-defined skills and commands; Claude Code's own built-ins stay out of the menu. */
export function toSkills(commands: SlashCommand[]): Skill[] {
  return commands
    .filter((command) => !command.builtin)
    .map((command) => ({ name: command.name, description: command.description, path: '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function blocksOf(message: unknown): ContentBlock[] {
  const content = (message as ApiMessage | null)?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
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
  return content
    .map((part: ContentBlock) => (part.type === 'text' ? (part.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

function upsert(blocks: Block[], next: Block): Block[] {
  const index = blocks.findIndex((block) => block.id === next.id)
  if (index === -1) return [...blocks, next]
  const copy = blocks.slice()
  copy[index] = next
  return copy
}

/** Attaches a tool's output to the callout its tool_use opened. */
function applyToolResult(blocks: Block[], part: ContentBlock): Block[] {
  const index = blocks.findIndex((block) => block.id === part.tool_use_id)
  const current = blocks[index]
  if (!current || current.kind !== 'callout') return blocks
  const output = resultText(part.content).trim().slice(0, 2000)
  const copy = blocks.slice()
  copy[index] = {
    ...current,
    title: current.title.replace(/^Running/, 'Ran').replace(/^Using/, 'Used'),
    body: output ? `${current.body}\n${output}` : current.body,
  }
  return copy
}

function applyToolUse(blocks: Block[], part: ContentBlock): Block[] {
  if (!part.id) return blocks
  return upsert(blocks, {
    kind: 'callout',
    id: part.id,
    title: toolTitle(part.name ?? 'a tool', false),
    body: toolBody(part.input),
  })
}

/** A person's turn: typed text, pasted images, and any skill invoked with /name. */
function userTurn(id: string, parts: ContentBlock[]): UserBlock | null {
  const block: UserBlock = { kind: 'user', id, text: '' }
  const text: string[] = []
  for (const part of parts) {
    if (part.type === 'image' && part.source?.type === 'base64') {
      ;(block.images ??= []).push(`data:${part.source.media_type};base64,${part.source.data}`)
    }
    if (part.type !== 'text' || !part.text || INJECTED.test(part.text)) continue
    const command = COMMAND.exec(part.text)?.[1]
    if (command) {
      ;(block.skills ??= []).push(command.trim())
      text.push(COMMAND_ARGS.exec(part.text)?.[1]?.trim() ?? '')
    } else if (!part.text.includes('<command-message>')) {
      text.push(part.text)
    }
  }
  block.text = text.filter(Boolean).join('\n')
  return block.text || block.images || block.skills ? block : null
}

/** Rebuilds a document from a saved transcript. Thinking and subagent traffic never reach the page. */
export function blocksFromSessionMessages(messages: SessionMessage[]): Block[] {
  let blocks: Block[] = []
  for (const message of messages) {
    if (message.parent_tool_use_id) continue
    const parts = blocksOf(message.message)
    if (message.type === 'user') {
      for (const part of parts) if (part.type === 'tool_result') blocks = applyToolResult(blocks, part)
      const turn = userTurn(message.uuid, parts)
      if (turn) blocks.push(turn)
      continue
    }
    if (message.type !== 'assistant') continue
    const id = (message.message as ApiMessage).id ?? message.uuid
    for (const part of parts) {
      if (part.type === 'tool_use') blocks = applyToolUse(blocks, part)
      if (part.type === 'text' && part.text) {
        const current = blocks.find((block) => block.id === id)
        blocks =
          current?.kind === 'agent'
            ? upsert(blocks, { ...current, text: `${current.text}\n\n${part.text}` })
            : [...blocks, { kind: 'agent', id, text: part.text }]
      }
    }
  }
  return blocks
}

/** Live-stream bookkeeping: which assistant message the next text delta belongs to. */
export type StreamState = { messageId: string | null; streamed: Set<string> }

export type StreamUpdate = { blocks: Block[]; done?: boolean; error?: string }

/** Folds one SDK frame into the page. Returns the same array when nothing visible changed. */
export function applyStreamMessage(blocks: Block[], message: SDKMessage, state: StreamState): StreamUpdate {
  if ('parent_tool_use_id' in message && message.parent_tool_use_id) return { blocks }
  if (message.type === 'stream_event') {
    const event = message.event
    if (event.type === 'message_start') state.messageId = event.message.id
    const id = state.messageId
    if (!id) return { blocks }
    if (event.type === 'content_block_start' && event.content_block.type === 'text') {
      const current = blocks.find((block) => block.id === id)
      if (current?.kind === 'agent' && current.text) return { blocks: upsertAgentDelta(blocks, id, '\n\n') }
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      state.streamed.add(id)
      return { blocks: upsertAgentDelta(blocks, id, event.delta.text) }
    }
    return { blocks }
  }
  if (message.type === 'assistant') {
    let next = blocks
    for (const part of blocksOf(message.message)) {
      if (part.type === 'tool_use') next = applyToolUse(next, part)
      // Text arrives twice with partial messages on; the deltas already drew it.
      if (part.type === 'text' && part.text && !state.streamed.has(message.message.id)) {
        next = upsertAgentDelta(next, message.message.id, part.text)
      }
    }
    return { blocks: next }
  }
  if (message.type === 'user') {
    let next = blocks
    for (const part of blocksOf(message.message)) if (part.type === 'tool_result') next = applyToolResult(next, part)
    return { blocks: next }
  }
  if (message.type === 'result') {
    const error =
      message.subtype === 'success' ? (message.is_error ? message.result : undefined) : message.errors.join('\n')
    return { blocks, done: true, error: error || undefined }
  }
  return { blocks }
}
