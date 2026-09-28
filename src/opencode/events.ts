import type { Block } from '../codex/blocks'
import type { Snapshot } from '../codex/types'
import type { OpenEvent, OpenMessagePart, PermissionAsked, QuestionAsked } from './client'
import {
  applyStreamText,
  joinParts,
  permissionApproval,
  questionApproval,
  toolCallout,
  upsertCallout,
} from './mapping'

export type EventContext = {
  getActiveId: () => string | null
  getBlocks: () => Block[]
  patch: (partial: Partial<Snapshot>) => void
  streamText: Map<string, Map<string, string>>
  reconcile: (id: string) => void
  replaceLocalEcho: (id: string) => void
  refreshThreads: () => void
}

type Props = Record<string, unknown>

export function handleEvent(event: OpenEvent, ctx: EventContext): void {
  const props = event.properties ?? {}
  const sessionId = typeof props.sessionID === 'string' ? props.sessionID : null
  switch (event.type) {
    case 'message.part.delta':
      handlePartDelta(props, sessionId, ctx)
      return
    case 'message.part.updated':
      handlePartUpdated(props, sessionId, ctx)
      return
    case 'message.updated':
      handleMessageUpdated(props, sessionId, ctx)
      return
    case 'session.idle':
      handleSessionIdle(sessionId, ctx)
      return
    case 'session.error':
      handleSessionError(props, sessionId, ctx)
      return
    case 'permission.asked':
    case 'permission.v2.asked':
      handlePermissionAsked(props, sessionId, ctx)
      return
    case 'permission.replied':
    case 'permission.v2.replied':
    case 'question.replied':
    case 'question.v2.replied':
    case 'question.rejected':
    case 'question.v2.rejected':
      handleApprovalResolved(props, ctx)
      return
    case 'question.asked':
    case 'question.v2.asked':
      handleQuestionAsked(props, sessionId, ctx)
      return
    case 'session.updated':
      handleSessionUpdated(props, ctx)
      return
    case 'session.created':
    case 'session.deleted':
      ctx.refreshThreads()
      return
    default:
      return
  }
}

function handlePartDelta(props: Props, sessionId: string | null, ctx: EventContext): void {
  if (!sessionId || sessionId !== ctx.getActiveId()) return
  const messageID = typeof props.messageID === 'string' ? props.messageID : null
  const partID = typeof props.partID === 'string' ? props.partID : null
  if (!messageID || !partID || props.field !== 'text' || typeof props.delta !== 'string') return
  let parts = ctx.streamText.get(messageID)
  if (!parts) {
    parts = new Map()
    ctx.streamText.set(messageID, parts)
  }
  parts.set(partID, (parts.get(partID) ?? '') + props.delta)
  ctx.patch({ blocks: applyStreamText(ctx.getBlocks(), messageID, joinParts(parts)) })
}

function handlePartUpdated(props: Props, sessionId: string | null, ctx: EventContext): void {
  if (!sessionId || sessionId !== ctx.getActiveId()) return
  const part = props.part as OpenMessagePart | undefined
  if (!part || typeof part.messageID !== 'string') return
  if (part.type === 'reasoning') {
    const parts = ctx.streamText.get(part.messageID)
    if (parts && parts.delete(part.id)) {
      ctx.patch({ blocks: applyStreamText(ctx.getBlocks(), part.messageID, joinParts(parts)) })
    }
    return
  }
  if (part.type === 'text' && !part.synthetic) {
    let parts = ctx.streamText.get(part.messageID)
    if (!parts) {
      parts = new Map()
      ctx.streamText.set(part.messageID, parts)
    }
    parts.set(part.id, part.text ?? '')
    ctx.patch({ blocks: applyStreamText(ctx.getBlocks(), part.messageID, joinParts(parts)) })
    return
  }
  if (part.type === 'tool') {
    ctx.patch({ blocks: upsertCallout(ctx.getBlocks(), toolCallout(part)) })
  }
}

function handleMessageUpdated(props: Props, sessionId: string | null, ctx: EventContext): void {
  if (!sessionId || sessionId !== ctx.getActiveId()) return
  const info = props.info as { id?: string; role?: string } | undefined
  if (info?.role === 'user' && info.id) ctx.replaceLocalEcho(info.id)
}

function handleSessionIdle(sessionId: string | null, ctx: EventContext): void {
  if (!sessionId || sessionId !== ctx.getActiveId()) return
  ctx.streamText.clear()
  ctx.reconcile(sessionId)
}

function handleSessionError(props: Props, sessionId: string | null, ctx: EventContext): void {
  if (!sessionId || sessionId !== ctx.getActiveId()) return
  const error = props.error as { message?: string } | undefined
  ctx.streamText.clear()
  ctx.patch({ streaming: false, error: error?.message ?? 'The assistant ran into an error.' })
}

function handlePermissionAsked(props: Props, sessionId: string | null, ctx: EventContext): void {
  if (!sessionId || sessionId !== ctx.getActiveId()) return
  const request = (props.request ?? props) as unknown as PermissionAsked
  if (!request || typeof request.id !== 'string') return
  if (ctx.getBlocks().some((block) => block.kind === 'approval' && block.requestId === request.id)) return
  ctx.patch({ blocks: [...ctx.getBlocks(), permissionApproval(request, sessionId)] })
}

function handleApprovalResolved(props: Props, ctx: EventContext): void {
  const requestId =
    typeof props.requestID === 'string'
      ? props.requestID
      : typeof (props as { id?: unknown }).id === 'string'
        ? ((props as { id?: unknown }).id as string)
        : null
  if (!requestId) return
  ctx.patch({
    blocks: ctx.getBlocks().map((block) =>
      block.kind === 'approval' && block.requestId === requestId && block.resolved === null
        ? { ...block, resolved: 'skipped' as const }
        : block,
    ),
  })
}

function handleQuestionAsked(props: Props, sessionId: string | null, ctx: EventContext): void {
  if (!sessionId || sessionId !== ctx.getActiveId()) return
  const request = (props.request ?? props) as unknown as QuestionAsked
  if (!request || typeof request.id !== 'string' || !Array.isArray(request.questions)) return
  if (ctx.getBlocks().some((block) => block.kind === 'approval' && block.requestId === request.id)) return
  ctx.patch({ blocks: [...ctx.getBlocks(), questionApproval(request, sessionId)] })
}

function handleSessionUpdated(props: Props, ctx: EventContext): void {
  const info = props.info as { id?: string; title?: string } | undefined
  if (info?.id === ctx.getActiveId() && info.title) ctx.patch({ title: info.title })
  ctx.refreshThreads()
}
