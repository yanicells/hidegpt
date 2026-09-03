import type { ThreadItem } from '../generated/codex/v2/ThreadItem'
import type { Turn } from '../generated/codex/v2/Turn'
import type { UserInput } from '../generated/codex/v2/UserInput'
import type { JsonRpcId } from './jsonrpc'

export type AgentBlock = { kind: 'agent'; id: string; text: string }
export type UserBlock = { kind: 'user'; id: string; text: string }
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

export function userText(content: UserInput[]): string {
  return content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .filter(Boolean)
    .join('\n')
}

export function itemToBlock(item: ThreadItem): Block | null {
  if (item.type === 'userMessage') {
    return { kind: 'user', id: item.id, text: userText(item.content) }
  }
  if (item.type === 'agentMessage') {
    return { kind: 'agent', id: item.id, text: item.text }
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
    return { kind: 'callout', id: item.id, title: item.type === 'enteredReviewMode' ? 'Review' : 'Left review', body: item.review }
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
