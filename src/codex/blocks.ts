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
}

export type Block = AgentBlock | UserBlock | CalloutBlock | PendingApproval

export function userText(content: UserInput[]): string {
  return content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .filter(Boolean)
    .join('\n')
}

export function itemToBlock(item: ThreadItem): Block {
  if (item.type === 'userMessage') {
    return { kind: 'user', id: item.id, text: userText(item.content) }
  }
  if (item.type === 'agentMessage') {
    return { kind: 'agent', id: item.id, text: item.text }
  }
  if (item.type === 'reasoning') {
    return {
      kind: 'callout',
      id: item.id,
      title: 'Notes',
      body: item.summary.join('\n') || item.content.join('\n'),
    }
  }
  if (item.type === 'commandExecution') {
    return {
      kind: 'callout',
      id: item.id,
      title: item.status === 'completed' ? 'Ran a command' : 'Running a command',
      body: item.command,
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
    return {
      kind: 'callout',
      id: item.id,
      title: `${item.server} · ${item.tool}`,
      body: item.status,
    }
  }
  if (item.type === 'webSearch') {
    return { kind: 'callout', id: item.id, title: 'Looked something up', body: item.query }
  }
  return { kind: 'callout', id: item.id, title: item.type, body: '' }
}

export function blocksFromTurns(turns: Turn[]): Block[] {
  const blocks: Block[] = []
  for (const turn of turns) {
    for (const item of turn.items) blocks.push(itemToBlock(item))
  }
  return blocks
}
