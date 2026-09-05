import type { Block } from '../codex/blocks'
import type { OpenCodeClient } from './client'

export function setDraft(blocks: Block[], blockId: string, key: string, value: string): Block[] {
  return blocks.map((block) =>
    block.kind === 'approval' && block.id === blockId ? { ...block, drafts: { ...block.drafts, [key]: value } } : block,
  )
}

export function resolveApproval(
  client: OpenCodeClient,
  blocks: Block[],
  blockId: string,
  accept: boolean,
  cwd: string,
  onError: (error: unknown) => void,
): Block[] {
  const block = blocks.find((item) => item.id === blockId)
  if (!block || block.kind !== 'approval' || block.resolved !== null) return blocks
  const extra = block.extra as { requestId: string; questions?: { id: string }[] } | undefined
  if (!extra?.requestId) return blocks
  if (block.method === 'opencode/permission') {
    void client.replyPermission(extra.requestId, accept, cwd).catch(onError)
  } else if (block.method === 'opencode/question') {
    if (accept) {
      const answers = (extra.questions ?? []).map((question) =>
        block.drafts[question.id] ? [block.drafts[question.id]] : [],
      )
      void client.replyQuestion(extra.requestId, answers, cwd).catch(onError)
    } else {
      void client.rejectQuestion(extra.requestId, cwd).catch(() => {})
    }
  }
  return blocks.map((item) => (item.id === blockId ? { ...item, resolved: accept ? 'accepted' : 'skipped' } : item))
}
