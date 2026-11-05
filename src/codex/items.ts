import type { ThreadItem } from '../generated/codex/v2/ThreadItem'
import type { Turn } from '../generated/codex/v2/Turn'
import type { UserInput } from '../generated/codex/v2/UserInput'
import type { JsonRpcId } from './jsonrpc'

export type AgentBlock = { kind: 'agent'; id: string; text: string; phase?: 'commentary' | 'final_answer' | null }
/** `images` are local file paths or data/http URLs; `skills` are skill names sent with the message. */
export type UserBlock = { kind: 'user'; id: string; text: string; images?: string[]; skills?: string[] }
export type CalloutBlock = { kind: 'callout'; id: string; title: string; body: string }
export type PendingApproval = {
  kind: 'approval'
  id: string
  requestId: JsonRpcId
  method: string
  title: string
  body: string
  resolved: 'accepted' | 'skipped' | null
  extra?: unknown
  drafts: Record<string, string>
}

export type Block = AgentBlock | UserBlock | CalloutBlock | PendingApproval

function userBlock(id: string, content: UserInput[]): UserBlock {
  const block: UserBlock = { kind: 'user', id, text: '' }
  const text: string[] = []
  for (const part of content) {
    if (part.type === 'text') text.push(part.text)
    else if (part.type === 'image') (block.images ??= []).push(part.url)
    else if (part.type === 'localImage') (block.images ??= []).push(part.path)
    else if (part.type === 'skill') (block.skills ??= []).push(part.name)
  }
  block.text = text.filter(Boolean).join('\n')
  return block
}

export function itemToBlock(item: ThreadItem): Block | null {
  if (item.type === 'userMessage') {
    return userBlock(item.id, item.content)
  }
  if (item.type === 'agentMessage') {
    return { kind: 'agent', id: item.id, text: item.text, phase: item.phase }
  }
  // Reasoning and plans stay off the page: the document shows outputs only.
  if (item.type === 'reasoning' || item.type === 'plan') {
    return null
  }
  if (item.type === 'commandExecution') {
    const output = item.aggregatedOutput?.trim()
    return {
      kind: 'callout',
      id: item.id,
      title: item.status === 'completed' ? 'Ran a command' : 'Running a command',
      body: output ? `${item.command}\n${output}` : item.command,
    }
  }
  if (item.type === 'fileChange') {
    return {
      kind: 'callout',
      id: item.id,
      title: `${item.changes.length} file change${item.changes.length === 1 ? '' : 's'}`,
      body: item.changes.map((change) => change.path).join('\n'),
    }
  }
  if (item.type === 'mcpToolCall') {
    const detail = item.error?.message ?? item.status
    return {
      kind: 'callout',
      id: item.id,
      title: `${item.server} · ${item.tool}`,
      body: detail,
    }
  }
  if (item.type === 'dynamicToolCall') {
    return {
      kind: 'callout',
      id: item.id,
      title: item.namespace ? `${item.namespace} · ${item.tool}` : item.tool,
      body: item.status,
    }
  }
  if (item.type === 'webSearch') {
    return { kind: 'callout', id: item.id, title: 'Looked something up', body: item.query }
  }
  if (item.type === 'imageView') {
    return { kind: 'callout', id: item.id, title: 'Image', body: item.path }
  }
  if (item.type === 'imageGeneration') {
    return {
      kind: 'callout',
      id: item.id,
      title: 'Generated image',
      body: item.savedPath ?? item.revisedPrompt ?? item.status,
    }
  }
  if (item.type === 'collabAgentToolCall') {
    return {
      kind: 'callout',
      id: item.id,
      title: `Agent · ${item.tool}`,
      body: item.prompt ?? item.status,
    }
  }
  if (item.type === 'contextCompaction') {
    return { kind: 'callout', id: item.id, title: 'Compacted context', body: '' }
  }
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    return {
      kind: 'callout',
      id: item.id,
      title: item.type === 'enteredReviewMode' ? 'Review' : 'Left review',
      body: item.review,
    }
  }
  if (item.type === 'functionCallOutput') {
    return { kind: 'callout', id: item.id, title: item.name, body: item.namespace ?? '' }
  }
  return { kind: 'callout', id: item.id, title: item.type, body: '' }
}

export function blocksFromTurns(turns: Turn[]): Block[] {
  const blocks: Block[] = []
  for (const turn of turns) {
    for (const item of turn.items) {
      const block = itemToBlock(item)
      if (block) blocks.push(block)
    }
  }
  return blocks
}

export function mergeOlderBlocks(older: Block[], current: Block[]): Block[] {
  const seen = new Set(current.map((block) => block.id))
  return [...older.filter((block) => !seen.has(block.id)), ...current]
}

export function upsertAgentDelta(blocks: Block[], itemId: string, delta: string): Block[] {
  const index = blocks.findIndex((block) => block.id === itemId)
  if (index === -1) {
    return [...blocks, { kind: 'agent', id: itemId, text: delta }]
  }
  const current = blocks[index]
  if (current.kind !== 'agent') return blocks
  const next = blocks.slice()
  next[index] = { ...current, text: current.text + delta }
  return next
}

export function upsertCalloutDelta(blocks: Block[], itemId: string, title: string, delta: string): Block[] {
  const index = blocks.findIndex((block) => block.id === itemId)
  if (index === -1) {
    return [...blocks, { kind: 'callout', id: itemId, title, body: delta }]
  }
  const current = blocks[index]
  if (current.kind !== 'callout') return blocks
  const next = blocks.slice()
  next[index] = { ...current, body: current.body + delta }
  return next
}

export function upsertCalloutReplace(blocks: Block[], itemId: string, title: string, body: string): Block[] {
  const index = blocks.findIndex((block) => block.id === itemId)
  if (index === -1) return [...blocks, { kind: 'callout', id: itemId, title, body }]
  const next = blocks.slice()
  const current = next[index]
  next[index] = current.kind === 'callout' ? { ...current, body } : { kind: 'callout', id: itemId, title, body }
  return next
}

export function upsertItem(blocks: Block[], item: ThreadItem): Block[] {
  const next = itemToBlock(item)
  // Hidden items (reasoning, plans) never touch the page.
  if (!next) return blocks
  const index = blocks.findIndex((block) => block.id === item.id)
  if (index === -1) {
    // The optimistic user echo (local-* id) is replaced by the server-echoed
    // item with the same text, so a sent message never appears twice.
    if (next.kind === 'user') {
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'user' && last.id.startsWith('local-') && sameUserInput(last, next)) {
        return [...blocks.slice(0, -1), next]
      }
    }
    return [...blocks, next]
  }
  const copy = blocks.slice()
  const previous = copy[index]
  if (previous.kind === 'agent' && next.kind === 'agent' && previous.text.length > next.text.length) {
    return copy
  }
  copy[index] = next
  return copy
}

function sameUserInput(a: UserBlock, b: UserBlock): boolean {
  return a.text === b.text && (a.images?.length ?? 0) === (b.images?.length ?? 0)
}
