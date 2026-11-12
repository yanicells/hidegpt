import type * as CodexRpc from '../vendor/effect-codex-app-server/rpc.ts'

import type { Block, UserBlock } from '../shared/model'

/** Maps Codex thread items onto the shared page blocks. Reasoning, plans, and subagent traffic stay off the page. */

export type ThreadItem = CodexRpc.ServerNotificationParamsByMethod['item/completed']['item']
export type Turn = CodexRpc.ClientRequestResponsesByMethod['thread/turns/list']['data'][number]
type UserInput = Extract<ThreadItem, { type: 'userMessage' }>['content'][number]

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
      return {
        kind: 'agent',
        id: item.id,
        text: item.text,
        ...(item.phase === 'commentary' ? { commentary: true } : {}),
      }
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
    default:
      return callout((item as { id: string }).id, (item as { type: string }).type, '')
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
