import { spawn } from 'node:child_process'

import type { Account } from '../generated/codex/v2/Account'
import type { CollaborationModeMask } from '../generated/codex/v2/CollaborationModeMask'
import type { CommandExecutionRequestApprovalParams } from '../generated/codex/v2/CommandExecutionRequestApprovalParams'
import type { FileChangeRequestApprovalParams } from '../generated/codex/v2/FileChangeRequestApprovalParams'
import type { GetAccountRateLimitsResponse } from '../generated/codex/v2/GetAccountRateLimitsResponse'
import type { GetAccountResponse } from '../generated/codex/v2/GetAccountResponse'
import type { LoginAccountResponse } from '../generated/codex/v2/LoginAccountResponse'
import type { McpServerElicitationRequestParams } from '../generated/codex/v2/McpServerElicitationRequestParams'
import type { Model } from '../generated/codex/v2/Model'
import type { ModelListResponse } from '../generated/codex/v2/ModelListResponse'
import type { PermissionsRequestApprovalParams } from '../generated/codex/v2/PermissionsRequestApprovalParams'
import type { Project } from '../generated/codex/v2/Project'
import type { ProjectListResponse } from '../generated/codex/v2/ProjectListResponse'
import type { Thread } from '../generated/codex/v2/Thread'
import type { ThreadItem } from '../generated/codex/v2/ThreadItem'
import type { ThreadListResponse } from '../generated/codex/v2/ThreadListResponse'
import type { ThreadResumeResponse } from '../generated/codex/v2/ThreadResumeResponse'
import type { ThreadSourceKind } from '../generated/codex/v2/ThreadSourceKind'
import type { ThreadStartResponse } from '../generated/codex/v2/ThreadStartResponse'

import { blocksFromTurns, itemToBlock, type Block, type PendingApproval } from './blocks'
import type { JsonRpcId } from './jsonrpc'
import { spawnCodexAppServer, type CodexTransport } from './transport'

const INTERACTIVE_SOURCES: ThreadSourceKind[] = ['cli', 'vscode', 'appServer']

export type Route = { kind: 'home' } | { kind: 'doc'; threadId: string }

export type Snapshot = {
  status: 'connecting' | 'ready' | 'error'
  error: string | null
  account: Account | null
  requiresAuth: boolean
  models: Model[]
  model: string | null
  effort: string | null
  collaborationModes: CollaborationModeMask[]
  collaborationMode: string | null
  projects: Project[]
  threads: Thread[]
  cwd: string
  rateLimits: GetAccountRateLimitsResponse | null
  route: Route
  title: string
  blocks: Block[]
  streaming: boolean
  loginUrl: string | null
  folderDraft: string
  showFolder: boolean
}

export const defaultCwd = () => `${process.env.HOME ?? ''}/.codex/threads`

function emptySnapshot(): Snapshot {
  return {
    status: 'connecting',
    error: null,
    account: null,
    requiresAuth: false,
    models: [],
    model: null,
    effort: null,
    collaborationModes: [],
    collaborationMode: null,
    projects: [],
    threads: [],
    cwd: defaultCwd(),
    rateLimits: null,
    route: { kind: 'home' },
    title: 'Docs',
    blocks: [],
    streaming: false,
    loginUrl: null,
    folderDraft: defaultCwd(),
    showFolder: false,
  }
}

export class CodexSession {
  snapshot: Snapshot = emptySnapshot()
  private listeners = new Set<() => void>()
  private transport: CodexTransport | null = null
  private unsubNote: (() => void) | null = null
  private unsubReq: (() => void) | null = null
  private activeThreadId: string | null = null

  constructor(private readonly createTransport: () => CodexTransport = spawnCodexAppServer) {}

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

  async start() {
    if (this.transport) return
    try {
      this.transport = this.createTransport()
      this.unsubNote = this.transport.onNotification((method, params) => {
        void this.onNotification(method, params)
      })
      this.unsubReq = this.transport.onRequest((request) => this.onServerRequest(request))
      this.transport.onDisconnect(() => {
        this.unsubNote = null
        this.unsubReq = null
        this.transport = null
        this.patch({ status: 'error', error: 'Codex disconnected. File → Refresh to reconnect.', streaming: false })
      })
      await this.transport.request('initialize', {
        clientInfo: { name: 'hidegpt', title: 'Docs', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      this.transport.notify('initialized')
      await this.refreshCatalog()
      this.patch({ status: 'ready', error: null })
    } catch (error) {
      await this.transport?.close()
      this.transport = null
      this.patch({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async close() {
    this.unsubNote?.()
    this.unsubReq?.()
    await this.transport?.close()
    this.transport = null
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    if (!this.transport) throw new Error('not connected')
    return this.transport.request<T>(method, params)
  }

  async refreshCatalog() {
    const account = await this.rpc<GetAccountResponse>('account/read', { refreshToken: false })
    const models = await this.rpc<ModelListResponse>('model/list', {})
    const threads = await this.listAllThreads()
    let projects: Project[] = []
    try {
      const listed = await this.rpc<ProjectListResponse>('project/list', { limit: 100 })
      projects = listed.data
    } catch {
      projects = []
    }
    let collaborationModes: CollaborationModeMask[] = []
    try {
      const listed = await this.rpc<{ data: CollaborationModeMask[] }>('collaborationMode/list', {})
      collaborationModes = listed.data
    } catch {
      collaborationModes = []
    }
    let rateLimits: GetAccountRateLimitsResponse | null = null
    try {
      rateLimits = await this.rpc<GetAccountRateLimitsResponse>('account/rateLimits/read', {})
    } catch {
      rateLimits = null
    }
    const visibleModels = models.data.filter((model) => !model.hidden)
    const selected =
      visibleModels.find((model) => model.isDefault) ?? visibleModels[0] ?? models.data[0]
    this.patch({
      account: account.account,
      requiresAuth: account.account == null || account.requiresOpenaiAuth,
      models: visibleModels.length > 0 ? visibleModels : models.data,
      model: this.snapshot.model ?? selected?.model ?? null,
      effort: this.snapshot.effort ?? selected?.defaultReasoningEffort ?? null,
      collaborationModes,
      collaborationMode: this.snapshot.collaborationMode ?? collaborationModes[0]?.name ?? null,
      projects,
      threads,
      rateLimits,
    })
  }

  private async listAllThreads(): Promise<Thread[]> {
    const all: Thread[] = []
    let nextCursor: string | null = null
    for (let page = 0; page < 8; page += 1) {
      const listed: ThreadListResponse = await this.rpc('thread/list', {
        cursor: nextCursor,
        limit: 50,
        sortKey: 'updated_at',
        sourceKinds: INTERACTIVE_SOURCES,
      })
      all.push(...listed.data)
      if (!listed.nextCursor) break
      nextCursor = listed.nextCursor
    }
    return all
  }

  goHome() {
    this.activeThreadId = null
    this.patch({ route: { kind: 'home' }, title: 'Docs', blocks: [], streaming: false })
  }

  setModel(model: string) {
    const entry = this.snapshot.models.find((item) => item.model === model)
    this.patch({
      model,
      effort: entry?.defaultReasoningEffort ?? this.snapshot.effort,
    })
  }

  setEffort(effort: string) {
    this.patch({ effort })
  }

  setCollaborationMode(name: string) {
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
  }

  async openThread(threadId: string) {
    try {
      const resumed = await this.rpc<ThreadResumeResponse>('thread/resume', {
        threadId,
        initialTurnsPage: { limit: 80, sortDirection: 'desc', itemsView: 'full' },
      })
      const turns =
        resumed.thread.turns.length > 0
          ? resumed.thread.turns
          : await this.loadTurns(resumed.thread.id, resumed.initialTurnsPage)
      this.activeThreadId = resumed.thread.id
      const title = resumed.thread.name?.trim() || resumed.thread.preview?.trim() || 'Untitled document'
      this.patch({
        route: { kind: 'doc', threadId: resumed.thread.id },
        title,
        blocks: blocksFromTurns(turns),
        cwd: typeof resumed.cwd === 'string' ? resumed.cwd : this.snapshot.cwd,
        model: resumed.model || this.snapshot.model,
        effort: resumed.reasoningEffort ?? this.snapshot.effort,
        streaming: false,
        error: null,
      })
    } catch (error) {
      this.patch({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async loadTurns(
    threadId: string,
    initial: { data: import('../generated/codex/v2/Turn').Turn[] } | null,
  ) {
    if (initial && initial.data.length > 0) return [...initial.data].reverse()
    try {
      const page = await this.rpc<{ data: import('../generated/codex/v2/Turn').Turn[] }>(
        'thread/turns/list',
        { threadId, limit: 80, sortDirection: 'desc', itemsView: 'full' },
      )
      return [...page.data].reverse()
    } catch {
      return []
    }
  }

  async newDocument() {
    const started = await this.rpc<ThreadStartResponse>('thread/start', {
      cwd: this.snapshot.cwd,
    })
    this.activeThreadId = started.thread.id
    this.patch({
      route: { kind: 'doc', threadId: started.thread.id },
      title: 'Untitled document',
      blocks: [],
      cwd: typeof started.cwd === 'string' ? started.cwd : this.snapshot.cwd,
      model: started.model || this.snapshot.model,
      effort: started.reasoningEffort ?? this.snapshot.effort,
      streaming: false,
    })
    await this.refreshCatalog()
  }

  async send(text: string) {
    const threadId = this.activeThreadId
    if (!threadId) return
    const trimmed = text.trim()
    if (!trimmed) return
    const userItem: ThreadItem = {
      type: 'userMessage',
      id: `local-${Date.now()}`,
      clientId: null,
      content: [{ type: 'text', text: trimmed, text_elements: [] }],
    }
    this.patch({
      blocks: [...this.snapshot.blocks, itemToBlock(userItem)],
      streaming: true,
    })
    const mode = this.snapshot.collaborationModes.find(
      (item) => item.name === this.snapshot.collaborationMode,
    )
    try {
      await this.rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text: trimmed, text_elements: [] }],
        model: this.snapshot.model,
        effort: this.snapshot.effort,
        collaborationMode: mode
          ? {
              mode: mode.mode ?? 'default',
              settings: {
                model: mode.model ?? this.snapshot.model ?? '',
                reasoning_effort: mode.reasoning_effort ?? this.snapshot.effort,
                developer_instructions: null,
              },
            }
          : undefined,
      })
    } catch (error) {
      this.patch({
        streaming: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async interrupt() {
    const threadId = this.activeThreadId
    if (!threadId) return
    try {
      await this.rpc('turn/interrupt', { threadId })
    } catch {
      // idle threads may reject interrupt
    }
    this.patch({ streaming: false })
  }

  async logout() {
    await this.rpc('account/logout', {})
    await this.refreshCatalog()
    this.goHome()
  }

  async login() {
    const result = await this.rpc<LoginAccountResponse>('account/login/start', {
      type: 'chatgpt',
      appBrand: 'chatgpt',
    })
    if (result.type === 'chatgpt') {
      this.patch({ loginUrl: result.authUrl })
      openUrl(result.authUrl)
    }
  }

  resolveApproval(blockId: string, accept: boolean) {
    const block = this.snapshot.blocks.find((item) => item.id === blockId)
    if (!block || block.kind !== 'approval' || block.resolved !== null || !this.transport) return
    this.transport.respond(block.requestId, approvalResult(block, accept))
    this.patch({
      blocks: this.snapshot.blocks.map((item) =>
        item.id === blockId ? { ...item, resolved: accept ? 'accepted' : 'skipped' } : item,
      ),
    })
  }

  private async onNotification(method: string, params: unknown) {
    const threadId = (params as { threadId?: string } | null)?.threadId
    if (threadId && this.activeThreadId && threadId !== this.activeThreadId) return

    if (method === 'item/agentMessage/delta') {
      const delta = params as { itemId: string; delta: string }
      this.patch({
        blocks: upsertAgentDelta(this.snapshot.blocks, delta.itemId, delta.delta),
        streaming: true,
      })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = (params as { item: ThreadItem }).item
      this.patch({ blocks: upsertItem(this.snapshot.blocks, item) })
      return
    }
    if (method === 'turn/completed' || method === 'turn/failed' || method === 'error') {
      this.patch({ streaming: false })
      return
    }
    if (method === 'thread/name/updated') {
      const name = (params as { threadName?: string }).threadName
      if (name) this.patch({ title: name })
      return
    }
    if (method === 'account/updated' || method === 'account/login/completed') {
      this.patch({ loginUrl: null })
      await this.refreshCatalog()
    }
  }

  private onServerRequest(request: { id: JsonRpcId; method: string; params: unknown }) {
    if (request.method === 'currentTime/read') {
      this.transport?.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) })
      return
    }
    const approval = approvalFromRequest(request)
    if (approval) {
      this.patch({ blocks: [...this.snapshot.blocks, approval] })
      if (request.method === 'mcpServer/elicitation/request') {
        const params = request.params as McpServerElicitationRequestParams
        if (params.mode === 'url') openUrl(params.url)
      }
      return
    }
    this.transport?.reject(request.id, `unhandled ${request.method}`)
  }
}

function openUrl(url: string) {
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
}

function upsertAgentDelta(blocks: Block[], itemId: string, delta: string): Block[] {
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

function upsertItem(blocks: Block[], item: ThreadItem): Block[] {
  const next = itemToBlock(item)
  const index = blocks.findIndex((block) => block.id === item.id)
  if (index === -1) return [...blocks, next]
  const copy = blocks.slice()
  const previous = copy[index]
  if (previous.kind === 'agent' && next.kind === 'agent' && previous.text.length > next.text.length) {
    return copy
  }
  copy[index] = next
  return copy
}

function approvalFromRequest(request: {
  id: JsonRpcId
  method: string
  params: unknown
}): PendingApproval | null {
  if (request.method === 'execCommandApproval' || request.method === 'item/commandExecution/requestApproval') {
    const params = request.params as CommandExecutionRequestApprovalParams & { command?: string | string[]; reason?: string | null }
    const command = Array.isArray(params.command) ? params.command.join(' ') : params.command
    return {
      kind: 'approval',
      id: `approval-${String(request.id)}`,
      requestId: request.id,
      method: request.method,
      title: 'Run command?',
      body: command ?? params.reason ?? 'Command',
      resolved: null,
    }
  }
  if (request.method === 'applyPatchApproval' || request.method === 'item/fileChange/requestApproval') {
    const params = request.params as FileChangeRequestApprovalParams
    return {
      kind: 'approval',
      id: `approval-${String(request.id)}`,
      requestId: request.id,
      method: request.method,
      title: 'Apply file changes?',
      body: params.reason ?? 'The assistant wants to edit files.',
      resolved: null,
    }
  }
  if (request.method === 'item/permissions/requestApproval') {
    const params = request.params as PermissionsRequestApprovalParams
    return {
      kind: 'approval',
      id: `approval-${String(request.id)}`,
      requestId: request.id,
      method: request.method,
      title: 'Grant extra access?',
      body: params.reason ?? 'The assistant needs more permissions.',
      resolved: null,
      extra: params,
    }
  }
  if (request.method === 'mcpServer/elicitation/request') {
    const params = request.params as McpServerElicitationRequestParams
    return {
      kind: 'approval',
      id: `approval-${String(request.id)}`,
      requestId: request.id,
      method: request.method,
      title: `Continue with ${params.serverName}?`,
      body: params.message,
      resolved: null,
      extra: params,
    }
  }
  if (request.method === 'item/tool/requestUserInput') {
    const params = request.params as { questions?: Array<{ prompt?: string }> }
    return {
      kind: 'approval',
      id: `approval-${String(request.id)}`,
      requestId: request.id,
      method: request.method,
      title: 'The assistant needs input',
      body: params.questions?.map((question) => question.prompt).filter(Boolean).join('\n') || 'Continue?',
      resolved: null,
    }
  }
  return null
}

function approvalResult(block: PendingApproval, accept: boolean): unknown {
  if (block.method === 'item/commandExecution/requestApproval') {
    return { decision: accept ? 'accept' : 'decline' }
  }
  if (block.method === 'item/fileChange/requestApproval') {
    return { decision: accept ? 'accept' : 'decline' }
  }
  if (block.method === 'item/permissions/requestApproval') {
    const params = block.extra as PermissionsRequestApprovalParams
    if (!accept) return { permissions: {}, scope: 'turn' }
    return {
      permissions: {
        network: params.permissions.network ?? undefined,
        fileSystem: params.permissions.fileSystem ?? undefined,
      },
      scope: 'session',
    }
  }
  if (block.method === 'mcpServer/elicitation/request') {
    return { action: accept ? 'accept' : 'cancel', content: null, _meta: null }
  }
  if (block.method === 'execCommandApproval' || block.method === 'applyPatchApproval') {
    return accept ? { decision: 'approved' } : { decision: { denied: { rejection: 'skipped' } } }
  }
  if (block.method === 'item/tool/requestUserInput') {
    return { answers: {} }
  }
  return {}
}

export function accountLabel(account: Account | null): string {
  if (!account) return 'Sign in'
  if (account.type === 'chatgpt') return account.email ?? 'ChatGPT'
  if (account.type === 'apiKey') return 'API key'
  return 'Account'
}
