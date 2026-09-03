import type { Model } from '../generated/codex/v2/Model'
import type { Project } from '../generated/codex/v2/Project'
import type { Thread } from '../generated/codex/v2/Thread'

import type { Block, PendingApproval } from '../codex/blocks'
import { defaultCwd } from '../codex/session'
import { emptySnapshot, type Snapshot } from '../codex/types'
import {
  startOpenCodeServer,
  type OpenCodeClient,
  type OpenCodeServer,
  type OpenEvent,
  type OpenMessage,
  type OpenMessagePart,
  type PermissionAsked,
  type QuestionAsked,
} from './client'

export type { Snapshot } from '../codex/types'

type ClientFactory = () => Promise<{ client: OpenCodeClient; version: string; close: () => Promise<void> }>

const defaultFactory: ClientFactory = () => startOpenCodeServer()

/** A CodexSession-compatible session backed by `opencode serve` (REST + SSE). */
export class OpenCodeSession {
  snapshot: Snapshot = { ...emptySnapshot(defaultCwd()), provider: 'opencode' }
  private listeners = new Set<() => void>()
  private server: OpenCodeServer | null = null
  private createClient: ClientFactory
  private abortEvents: AbortController | null = null
  private activeSessionId: string | null = null
  private model: { providerID: string; modelID: string } | null = null
  private agent = 'build'
  private agents: string[] = []
  /** messageId -> partId -> accumulated text for the live turn. */
  private streamText = new Map<string, Map<string, string>>()
  private nav = 0

  constructor(createClient: ClientFactory = defaultFactory) {
    this.createClient = createClient
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.snapshot

  private emit() {
    for (const listener of this.listeners) listener()
  }

  private patch(partial: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...partial }
    this.emit()
  }

  private get client(): OpenCodeClient | null {
    return this.server?.client ?? null
  }

  async start() {
    if (this.server) return
    try {
      this.server = await this.createClient()
      this.subscribeToEvents()
      await this.refreshCatalog()
      this.patch({ status: 'ready', error: null })
    } catch (error) {
      this.patch({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  async close() {
    this.abortEvents?.abort()
    this.abortEvents = null
    await this.server?.close().catch(() => {})
    this.server = null
  }

  private subscribeToEvents() {
    const client = this.client
    if (!client) return
    this.abortEvents?.abort()
    this.abortEvents = new AbortController()
    try {
      client.subscribeEvents((event) => this.onEvent(event), this.abortEvents.signal)
    } catch {
      // event stream failures surface on next user action; catalog still works
    }
  }

  async refreshCatalog() {
    const client = this.client
    if (!client) return
    try {
      const [sessions, models, agents, projects, defaults] = await Promise.all([
        client.listSessions({ search: this.snapshot.search || undefined, limit: 100 }),
        client.listModels(),
        client.listAgents(),
        client.listProjects(),
        client.providerDefaults(),
      ])
      this.agents = agents.map((agent) => agent.name)
      if (!this.agents.includes(this.agent)) this.agent = this.agents[0] ?? 'build'
      const mappedModels = models.map(toCodexModel)
      if (!this.model) {
        const preferred = preferredDefault(defaults, models.map((m) => `${m.providerID}/${m.id}`))
        const fallback = mappedModels.find((m) => m.isDefault) ?? mappedModels[0]
        const chosen = preferred ?? fallback?.model ?? null
        this.model = chosen ? splitModelId(chosen) : null
      }
      this.patch({
        models: mappedModels,
        model: this.model ? `${this.model.providerID}/${this.model.modelID}` : null,
        effort: null,
        collaborationModes: agents.map((agent) => ({
          name: agent.name,
          mode: null,
          model: null,
          reasoning_effort: null,
        })),
        collaborationMode: this.agent,
        projects: projects.map(toCodexProject),
        threads: sessions.map(toCodexThread),
        account: null,
        requiresAuth: false,
        rateLimits: null,
        mcpServers: [],
      })
    } catch (error) {
      this.patch({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  setSearch(value: string) {
    this.patch({ search: value })
  }

  async applySearch() {
    if (!this.client) return
    try {
      const sessions = await this.client.listSessions({ search: this.snapshot.search || undefined, limit: 100 })
      this.patch({ threads: sessions.map(toCodexThread) })
    } catch (error) {
      this.patch({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  goHome() {
    this.nav += 1
    this.activeSessionId = null
    this.streamText.clear()
    this.patch({
      route: { kind: 'home' },
      title: 'Docs',
      blocks: [],
      streaming: false,
      olderTurnsCursor: null,
      loadingOlder: false,
    })
  }

  setModel(model: string) {
    this.model = splitModelId(model)
    this.patch({ model })
  }

  setEffort(_effort: string) {
    // OpenCode models carry no separate effort dial; variants live in the model id.
  }

  setCollaborationMode(name: string) {
    // The mode chip doubles as the OpenCode agent picker (build / plan / …).
    if (this.agents.length > 0 && !this.agents.includes(name)) return
    this.agent = name
    this.patch({ collaborationMode: name })
  }

  toggleFolder(show: boolean) {
    this.patch({ showFolder: show, folderDraft: this.snapshot.cwd })
  }

  setFolderDraft(value: string) {
    this.patch({ folderDraft: value })
  }

  applyFolder() {
    const cwd = this.snapshot.folderDraft.trim() || defaultCwd()
    this.patch({ cwd, showFolder: false, folderDraft: cwd })
    // Sessions belong to the server's working directory, so relaunch it there.
    void this.restart()
  }

  private async restart() {
    await this.close()
    this.patch({ status: 'connecting' })
    await this.start()
  }

  async openThread(threadId: string) {
    this.nav += 1
    const token = this.nav
    const client = this.client
    if (!client) return
    try {
      const messages = await client.listMessages(threadId, 200)
      if (token !== this.nav) return
      const sessions = await client.listSessions({ limit: 100 })
      const session = sessions.find((item) => item.id === threadId)
      if (token !== this.nav) return
      this.activeSessionId = threadId
      this.streamText.clear()
      if (session?.model) this.model = { ...session.model }
      if (session?.agent) this.agent = session.agent
      this.patch({
        route: { kind: 'doc', threadId },
        title: sessionTitle(session?.title, messages),
        blocks: blocksFromMessages(messages),
        cwd: session?.directory ?? this.snapshot.cwd,
        model: this.model ? `${this.model.providerID}/${this.model.modelID}` : this.snapshot.model,
        collaborationMode: this.agent,
        streaming: false,
        error: null,
        olderTurnsCursor: null,
        loadingOlder: false,
      })
    } catch (error) {
      if (token !== this.nav) return
      this.patch({ error: error instanceof Error ? error.message : String(error), route: { kind: 'home' } })
    }
  }

  async loadOlderTurns() {
    // Message history loads in one page; nothing older to fetch.
  }

  async newDocument() {
    this.nav += 1
    const token = this.nav
    const client = this.client
    if (!client) return
    try {
      const session = await client.createSession({ agent: this.agent, model: this.model ?? undefined })
      if (token !== this.nav) return
      this.activeSessionId = session.id
      this.streamText.clear()
      this.patch({
        route: { kind: 'doc', threadId: session.id },
        title: 'Untitled document',
        blocks: [],
        cwd: session.directory || this.snapshot.cwd,
        streaming: false,
        error: null,
        olderTurnsCursor: null,
        loadingOlder: false,
      })
      await this.refreshThreads()
    } catch (error) {
      if (token !== this.nav) return
      this.patch({ error: error instanceof Error ? error.message : String(error), route: { kind: 'home' } })
    }
  }

  async send(text: string) {
    const client = this.client
    const sessionId = this.activeSessionId
    if (!client || !sessionId || this.snapshot.streaming) return
    const trimmed = text.trim()
    if (!trimmed) return
    if (!this.model) {
      this.patch({ error: 'Pick a model first.' })
      return
    }
    this.patch({
      blocks: [...this.snapshot.blocks, { kind: 'user', id: `local-${Date.now()}`, text: trimmed }],
      streaming: true,
      error: null,
    })
    try {
      await client.promptAsync(sessionId, { model: this.toApiModel(), agent: this.agent, text: trimmed })
    } catch (error) {
      this.patch({ streaming: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private toApiModel(): { providerID: string; modelID: string } {
    return this.model ?? { providerID: '', modelID: '' }
  }

  async interrupt() {
    const client = this.client
    const sessionId = this.activeSessionId
    if (!client || !sessionId) return
    try {
      await client.abort(sessionId)
    } catch {
      // idle sessions may reject abort
    }
    this.streamText.clear()
    this.patch({ streaming: false })
    await this.reconcile(sessionId)
  }

  async setDocumentName(name: string) {
    // OpenCode titles sessions automatically; renaming is not exposed — keep local title.
    const trimmed = name.trim()
    if (!trimmed || trimmed === this.snapshot.title) return
    this.patch({
      title: trimmed,
      threads: this.snapshot.threads.map((thread) =>
        thread.id === this.activeSessionId ? { ...thread, name: trimmed } : thread,
      ),
    })
  }

  async logout() {
    this.patch({ error: 'OpenCode signs in outside Docs — run `opencode auth logout` in a terminal.' })
  }

  async login() {
    this.patch({ error: 'OpenCode signs in outside Docs — run `opencode auth login` in a terminal, then Refresh.' })
  }

  async connectMcp(_name: string) {
    this.patch({ error: 'Manage OpenCode tools with `opencode mcp` in a terminal.' })
  }

  setApprovalDraft(blockId: string, key: string, value: string) {
    this.patch({
      blocks: this.snapshot.blocks.map((item) =>
        item.kind === 'approval' && item.id === blockId
          ? { ...item, drafts: { ...item.drafts, [key]: value } }
          : item,
      ),
    })
  }

  resolveApproval(blockId: string, accept: boolean) {
    const client = this.client
    const block = this.snapshot.blocks.find((item) => item.id === blockId)
    if (!block || block.kind !== 'approval' || block.resolved !== null || !client) return
    const extra = block.extra as { requestId: string; questions?: { id: string }[] } | undefined
    if (!extra?.requestId) return
    if (block.method === 'opencode/permission') {
      void client.replyPermission(extra.requestId, accept).catch((error: unknown) => {
        this.patch({ error: error instanceof Error ? error.message : String(error) })
      })
    } else if (block.method === 'opencode/question') {
      if (accept) {
        const answers = (extra.questions ?? []).map((question) => {
          const value = block.drafts[question.id] ?? ''
          return value ? [value] : []
        })
        void client.replyQuestion(extra.requestId, answers).catch((error: unknown) => {
          this.patch({ error: error instanceof Error ? error.message : String(error) })
        })
      } else {
        void client.rejectQuestion(extra.requestId).catch(() => {})
      }
    }
    this.patch({
      blocks: this.snapshot.blocks.map((item) =>
        item.id === blockId ? { ...item, resolved: accept ? 'accepted' : 'skipped' } : item,
      ),
    })
  }

  private async refreshThreads() {
    const client = this.client
    if (!client) return
    try {
      const sessions = await client.listSessions({ search: this.snapshot.search || undefined, limit: 100 })
      this.patch({ threads: sessions.map(toCodexThread) })
    } catch {
      // home list refresh is best-effort
    }
  }

  private async reconcile(sessionId: string) {
    const client = this.client
    if (!client || this.activeSessionId !== sessionId) return
    try {
      const messages = await client.listMessages(sessionId, 200)
      if (this.activeSessionId !== sessionId) return
      const approvals = this.snapshot.blocks.filter((block) => block.kind === 'approval')
      this.patch({
        blocks: [...blocksFromMessages(messages), ...approvals.filter((approval) => !messages.some((m) => m.info.id === approval.id))],
        streaming: false,
      })
    } catch {
      this.patch({ streaming: false })
    }
  }

  private onEvent(event: OpenEvent) {
    const props = event.properties ?? {}
    const sessionId = typeof props.sessionID === 'string' ? props.sessionID : null
    switch (event.type) {
      case 'message.part.delta': {
        if (sessionId !== this.activeSessionId) return
        const messageID = typeof props.messageID === 'string' ? props.messageID : null
        const partID = typeof props.partID === 'string' ? props.partID : null
        if (!messageID || !partID || props.field !== 'text' || typeof props.delta !== 'string') return
        let parts = this.streamText.get(messageID)
        if (!parts) {
          parts = new Map()
          this.streamText.set(messageID, parts)
        }
        parts.set(partID, (parts.get(partID) ?? '') + props.delta)
        this.patch({ blocks: applyStreamText(this.snapshot.blocks, messageID, joinParts(parts)) })
        return
      }
      case 'message.part.updated': {
        if (sessionId !== this.activeSessionId) return
        const part = props.part as OpenMessagePart | undefined
        if (!part || typeof part.messageID !== 'string') return
        if (part.type === 'reasoning') return
        if (part.type === 'text' && !part.synthetic) {
          let parts = this.streamText.get(part.messageID)
          if (!parts) {
            parts = new Map()
            this.streamText.set(part.messageID, parts)
          }
          parts.set(part.id, part.text ?? '')
          this.patch({ blocks: applyStreamText(this.snapshot.blocks, part.messageID, joinParts(parts)) })
          return
        }
        if (part.type === 'tool') {
          this.patch({ blocks: upsertCallout(this.snapshot.blocks, toolCallout(part)) })
          return
        }
        return
      }
      case 'message.updated': {
        if (sessionId !== this.activeSessionId) return
        const info = props.info as { id?: string; role?: string } | undefined
        // The server echo of our optimistic user message: same text, server id wins.
        if (info?.role === 'user' && info.id) {
          void this.replaceLocalEcho(info.id)
        }
        return
      }
      case 'session.idle': {
        if (!sessionId || sessionId !== this.activeSessionId) return
        this.streamText.clear()
        void this.reconcile(sessionId)
        return
      }
      case 'session.error': {
        if (!sessionId || sessionId !== this.activeSessionId) return
        const error = props.error as { message?: string } | undefined
        this.streamText.clear()
        this.patch({ streaming: false, error: error?.message ?? 'The assistant ran into an error.' })
        return
      }
      case 'permission.asked':
      case 'permission.v2.asked': {
        if (sessionId !== this.activeSessionId) return
        const request = (props.request ?? props) as unknown as PermissionAsked
        if (!request || typeof request.id !== 'string') return
        this.patch({ blocks: [...this.snapshot.blocks, permissionApproval(request)] })
        return
      }
      case 'permission.replied':
      case 'permission.v2.replied':
      case 'question.replied':
      case 'question.v2.replied':
      case 'question.rejected':
      case 'question.v2.rejected': {
        const requestId =
          typeof props.requestID === 'string'
            ? props.requestID
            : typeof (props as { id?: unknown }).id === 'string'
              ? ((props as { id?: unknown }).id as string)
              : null
        if (!requestId) return
        this.patch({
          blocks: this.snapshot.blocks.map((block) =>
            block.kind === 'approval' && block.requestId === requestId && block.resolved === null
              ? { ...block, resolved: 'skipped' as const }
              : block,
          ),
        })
        return
      }
      case 'question.asked':
      case 'question.v2.asked': {
        if (sessionId !== this.activeSessionId) return
        const request = (props.request ?? props) as unknown as QuestionAsked
        if (!request || typeof request.id !== 'string' || !Array.isArray(request.questions)) return
        this.patch({ blocks: [...this.snapshot.blocks, questionApproval(request)] })
        return
      }
      case 'session.updated': {
        const info = props.info as { id?: string; title?: string } | undefined
        if (info?.id === this.activeSessionId && info.title) this.patch({ title: info.title })
        void this.refreshThreads()
        return
      }
      case 'session.created':
      case 'session.deleted': {
        void this.refreshThreads()
        return
      }
      default:
        return
    }
  }

  private async replaceLocalEcho(serverId: string) {
    const client = this.client
    const sessionId = this.activeSessionId
    if (!client || !sessionId) return
    try {
      const messages = await client.listMessages(sessionId, 20)
      const userMessages = messages.filter((message) => message.info.role === 'user')
      const latest = userMessages[userMessages.length - 1]
      if (!latest) return
      this.patch({
        blocks: this.snapshot.blocks.map((block) =>
          block.kind === 'user' && block.id.startsWith('local-') && block.text === userText(latest)
            ? { ...block, id: serverId }
            : block,
        ),
      })
    } catch {
      // echo reconciliation is best-effort; idle reconcile fixes stragglers
    }
  }
}

function preferredDefault(defaults: Record<string, string>, available: string[]): string | null {
  const values = Object.entries(defaults)
  const exact = values.find(([provider, model]) => available.includes(`${provider}/${model}`))
  if (exact) return `${exact[0]}/${exact[1]}`
  return null
}

function splitModelId(id: string): { providerID: string; modelID: string } {
  const slash = id.indexOf('/')
  if (slash === -1) return { providerID: '', modelID: id }
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}

function joinParts(parts: Map<string, string>): string {
  return [...parts.values()].join('\n\n')
}

function applyStreamText(blocks: Block[], messageId: string, text: string): Block[] {
  const index = blocks.findIndex((block) => block.id === messageId)
  if (index === -1) return [...blocks, { kind: 'agent', id: messageId, text }]
  const current = blocks[index]
  if (current.kind !== 'agent') return blocks
  if (current.text === text) return blocks
  const next = blocks.slice()
  next[index] = { ...current, text }
  return next
}

function upsertCallout(blocks: Block[], callout: Block): Block[] {
  const index = blocks.findIndex((block) => block.id === callout.id)
  if (index === -1) return [...blocks, callout]
  const next = blocks.slice()
  next[index] = callout
  return next
}

function userText(message: OpenMessage): string {
  return message.parts
    .filter((part) => part.type === 'text' && !part.synthetic)
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n')
}

function assistantText(message: OpenMessage): string {
  return message.parts
    .filter((part) => part.type === 'text' && !part.synthetic)
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n\n')
}

function toolCallout(part: OpenMessagePart): Block {
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

function blocksFromMessages(messages: OpenMessage[]): Block[] {
  const blocks: Block[] = []
  for (const message of messages) {
    if (message.info.role === 'user') {
      const text = userText(message)
      if (text) blocks.push({ kind: 'user', id: message.info.id, text })
      continue
    }
    const text = assistantText(message)
    if (text) blocks.push({ kind: 'agent', id: message.info.id, text })
    for (const part of message.parts) {
      if (part.type === 'tool') blocks.push(toolCallout(part))
    }
  }
  return blocks
}

function sessionTitle(title: string | undefined, messages: OpenMessage[]): string {
  if (title?.trim()) return title.trim()
  const firstUser = messages.find((message) => message.info.role === 'user')
  const text = firstUser ? userText(firstUser) : ''
  return text.split('\n')[0]?.trim() || 'Untitled document'
}

function permissionApproval(request: PermissionAsked): PendingApproval {
  const patterns = request.patterns?.length ? `: ${request.patterns.join(', ')}` : ''
  return {
    kind: 'approval',
    id: `approval-${request.id}`,
    requestId: request.id,
    method: 'opencode/permission',
    title: `Allow ${request.permission}${patterns}?`,
    body: 'The assistant is asking for extra access.',
    resolved: null,
    extra: { requestId: request.id },
    drafts: {},
  }
}

function questionApproval(request: QuestionAsked): PendingApproval {
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
    extra: { requestId: request.id, questions },
    drafts: {},
  }
}

function toCodexThread(session: {
  id: string
  title: string
  directory: string
  projectID: string
  time: { created: number; updated: number }
}): Thread {
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

function toCodexModel(model: { id: string; providerID: string; name: string }, index: number): Model {
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

function toCodexProject(project: { id: string; name: string }): Project {
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
