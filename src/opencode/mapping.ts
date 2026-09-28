import type { Model } from '../generated/codex/v2/Model'
import type { Project } from '../generated/codex/v2/Project'
import type { Thread } from '../generated/codex/v2/Thread'

import type { Block, PendingApproval } from '../codex/blocks'
import type {
  OpenMessage,
  OpenMessagePart,
  OpenProviderModel,
  OpenSession,
  PermissionAsked,
  QuestionAsked,
} from './client'

export function splitModelId(id: string): { providerID: string; modelID: string } {
  const slash = id.indexOf('/')
  if (slash === -1) return { providerID: '', modelID: id }
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}

export function preferredDefault(defaults: Record<string, string>, available: string[]): string | null {
  const exact = Object.entries(defaults).find(([provider, model]) => available.includes(`${provider}/${model}`))
  return exact ? `${exact[0]}/${exact[1]}` : null
}

export function messageText(message: OpenMessage, separator: string): string {
  return message.parts
    .filter((part) => part.type === 'text' && !part.synthetic)
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join(separator)
}

export function toolCallout(part: OpenMessagePart): Block {
  const state = part.state
  const status = state?.status ?? ''
  const output = typeof state?.output === 'string' ? state.output : ''
  const body = output ? output.slice(0, 2000) : status
  return {
    kind: 'callout',
    id: part.id,
    title: part.tool ? `Ran ${part.tool}` : 'Tool',
    body,
  }
}

export function joinParts(parts: Map<string, string>): string {
  return [...parts.values()].join('\n\n')
}

export function applyStreamText(blocks: Block[], messageId: string, text: string): Block[] {
  const index = blocks.findIndex((block) => block.id === messageId)
  if (index === -1) return [...blocks, { kind: 'agent', id: messageId, text }]
  const current = blocks[index]
  if (current.kind !== 'agent') return blocks
  if (current.text === text) return blocks
  const next = blocks.slice()
  next[index] = { ...current, text }
  return next
}

export function upsertCallout(blocks: Block[], callout: Block): Block[] {
  const index = blocks.findIndex((block) => block.id === callout.id)
  if (index === -1) return [...blocks, callout]
  const next = blocks.slice()
  next[index] = callout
  return next
}

export function blocksFromMessages(messages: OpenMessage[]): Block[] {
  const blocks: Block[] = []
  for (const message of messages) {
    if (message.info.role === 'user') {
      const text = messageText(message, '\n')
      if (text) blocks.push({ kind: 'user', id: message.info.id, text })
      continue
    }
    const text = messageText(message, '\n\n')
    if (text) blocks.push({ kind: 'agent', id: message.info.id, text })
    for (const part of message.parts) {
      if (part.type === 'tool') blocks.push(toolCallout(part))
    }
  }
  return blocks
}

export function sessionTitle(title: string | undefined, messages: OpenMessage[]): string {
  if (title?.trim()) return title.trim()
  const firstUser = messages.find((message) => message.info.role === 'user')
  const text = firstUser ? messageText(firstUser, '\n') : ''
  return text.split('\n')[0]?.trim() || 'Untitled document'
}

export function permissionApproval(request: PermissionAsked, sessionId: string | null): PendingApproval {
  const patterns = request.patterns?.length ? `: ${request.patterns.join(', ')}` : ''
  return {
    kind: 'approval',
    id: `approval-${request.id}`,
    requestId: request.id,
    method: 'opencode/permission',
    title: `Allow ${request.permission}${patterns}?`,
    body: 'The assistant is asking for extra access.',
    resolved: null,
    extra: { requestId: request.id, sessionId },
    drafts: {},
  }
}

export function questionApproval(request: QuestionAsked, sessionId: string | null): PendingApproval {
  const questions = request.questions.map((question, index) => ({
    id: `q${index}`,
    header: question.header,
    question: question.question,
    isOther: question.options.length === 0,
    isSecret: false,
    options: question.options.map((option) => ({ label: option.label, description: option.description })),
  }))
  return {
    kind: 'approval',
    id: `approval-${request.id}`,
    requestId: request.id,
    method: 'opencode/question',
    title: 'The assistant needs input',
    body: request.questions.map((question) => question.question).filter(Boolean).join('\n') || 'Continue?',
    resolved: null,
    extra: { requestId: request.id, sessionId, questions },
    drafts: {},
  }
}

export function toCodexThread(session: OpenSession): Thread {
  const at = Math.floor((session.time.updated || session.time.created || Date.now()) / 1000)
  const created = Math.floor((session.time.created || Date.now()) / 1000)
  return {
    id: session.id,
    extra: null,
    sessionId: session.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: session.title || 'Untitled document',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: session.projectID || null,
    historyMode: 'legacy',
    modelProvider: 'openai',
    createdAt: created,
    updatedAt: at,
    recencyAt: at,
    status: { type: 'notLoaded' },
    path: null,
    cwd: session.directory,
    cliVersion: '0',
    source: 'vscode',
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: session.title || null,
    turns: [],
  }
}

export function toCodexModel(model: OpenProviderModel, index: number): Model {
  return {
    id: `${model.providerID}/${model.id}`,
    model: `${model.providerID}/${model.id}`,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: model.name,
    description: '',
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    inputModalities: [],
    supportsPersonality: true,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: index === 0,
  }
}

export function toCodexProject(project: { id: string; name: string }): Project {
  return {
    id: project.id,
    name: project.name,
    roots: [],
    metadata: {},
    position: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}
