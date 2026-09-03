import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

import type { AccountRateLimitsUpdatedNotification } from '../generated/codex/v2/AccountRateLimitsUpdatedNotification'
import type { ChatgptAuthTokensRefreshResponse } from '../generated/codex/v2/ChatgptAuthTokensRefreshResponse'
import type { CollaborationModeMask } from '../generated/codex/v2/CollaborationModeMask'
import type { CommandExecutionRequestApprovalParams } from '../generated/codex/v2/CommandExecutionRequestApprovalParams'
import type { ErrorNotification } from '../generated/codex/v2/ErrorNotification'
import type { FileChangeRequestApprovalParams } from '../generated/codex/v2/FileChangeRequestApprovalParams'
import type { GetAccountRateLimitsResponse } from '../generated/codex/v2/GetAccountRateLimitsResponse'
import type { GetAccountResponse } from '../generated/codex/v2/GetAccountResponse'
import type { ListMcpServerStatusResponse } from '../generated/codex/v2/ListMcpServerStatusResponse'
import type { LoginAccountResponse } from '../generated/codex/v2/LoginAccountResponse'
import type { McpServerElicitationRequestParams } from '../generated/codex/v2/McpServerElicitationRequestParams'
import type { McpServerOauthLoginResponse } from '../generated/codex/v2/McpServerOauthLoginResponse'
import type { McpServerStatus } from '../generated/codex/v2/McpServerStatus'
import type { ModelListResponse } from '../generated/codex/v2/ModelListResponse'
import type { PermissionsRequestApprovalParams } from '../generated/codex/v2/PermissionsRequestApprovalParams'
import type { Project } from '../generated/codex/v2/Project'
import type { ProjectListResponse } from '../generated/codex/v2/ProjectListResponse'
import type { ServerRequestResolvedNotification } from '../generated/codex/v2/ServerRequestResolvedNotification'
import type { Thread } from '../generated/codex/v2/Thread'
import type { ThreadItem } from '../generated/codex/v2/ThreadItem'
import type { ThreadListResponse } from '../generated/codex/v2/ThreadListResponse'
import type { ThreadResumeResponse } from '../generated/codex/v2/ThreadResumeResponse'
import type { ThreadSourceKind } from '../generated/codex/v2/ThreadSourceKind'
import type { ThreadStartResponse } from '../generated/codex/v2/ThreadStartResponse'
import type { ToolRequestUserInputParams } from '../generated/codex/v2/ToolRequestUserInputParams'
import type { Turn } from '../generated/codex/v2/Turn'
import type { TurnCompletedNotification } from '../generated/codex/v2/TurnCompletedNotification'
import type { TurnsPage } from '../generated/codex/v2/TurnsPage'
import type { WarningNotification } from '../generated/codex/v2/WarningNotification'

import {
  blocksFromTurns,
  itemToBlock,
  mergeOlderBlocks,
  type Block,
  type PendingApproval,
} from './blocks'
import type { JsonRpcId } from './jsonrpc'
import { elicitationProperties, formatCodexError } from './labels'
import { spawnCodexAppServer, type CodexTransport } from './transport'
import { emptySnapshot, type Snapshot } from './types'

export type { Route, Snapshot } from './types'

const INTERACTIVE_SOURCES: ThreadSourceKind[] = ['cli', 'vscode', 'appServer']

export const defaultCwd = () => `${process.env.HOME ?? process.env.USERPROFILE ?? ''}/.codex/threads`

export class CodexSession {
  snapshot: Snapshot = emptySnapshot(defaultCwd())
  private listeners = new Set<() => void>()
  private transport: CodexTransport | null = null
  private unsubNote: (() => void) | null = null
  private unsubReq: (() => void) | null = null
  private activeThreadId: string | null = null
  private leaveInFlight: Promise<void> = Promise.resolve()
  private openInFlight: Promise<void> = Promise.resolve()
  private nav = 0

  constructor(
    private readonly createTransport: () => CodexTransport = spawnCodexAppServer,
    private readonly openUrlFn: (url: string) => void = defaultOpenUrl,
  ) {}

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
    const reopenId = this.snapshot.route.kind === 'doc' ? this.snapshot.route.threadId : null
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
      if (reopenId) await this.openThread(reopenId)
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
    await this.leaveThread()
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
    let mcpServers: McpServerStatus[] = []
    try {
      const listed = await this.rpc<ListMcpServerStatusResponse>('mcpServerStatus/list', {
        detail: 'toolsAndAuthOnly',
        threadId: this.activeThreadId,
      })
      mcpServers = listed.data
    } catch {
      mcpServers = []
    }
    const visibleModels = models.data.filter((model) => !model.hidden)
    const selected =
      visibleModels.find((model) => model.isDefault) ?? visibleModels[0] ?? models.data[0]
    this.patch({
      account: account.account,
      requiresAuth: account.account == null,
      models: visibleModels.length > 0 ? visibleModels : models.data,
      model: this.snapshot.model ?? selected?.model ?? null,
      effort: this.snapshot.effort ?? selected?.defaultReasoningEffort ?? null,
      collaborationModes,
      collaborationMode: this.snapshot.collaborationMode ?? collaborationModes[0]?.name ?? null,
      projects,
      threads,
      rateLimits,
      mcpServers,
    })
  }

  private async listAllThreads(): Promise<Thread[]> {
    const all: Thread[] = []
    let nextCursor: string | null = null
    const search = this.snapshot.search.trim()
    for (let page = 0; page < 20; page += 1) {
      const listed: ThreadListResponse = await this.rpc('thread/list', {
        cursor: nextCursor,
        limit: 50,
        sortKey: 'updated_at',
        sourceKinds: INTERACTIVE_SOURCES,
        searchTerm: search || null,
      })
      all.push(...listed.data)
      if (!listed.nextCursor) break
      nextCursor = listed.nextCursor
    }
    return all
  }

  setSearch(value: string) {
    this.patch({ search: value })
  }

  async applySearch() {
    if (!this.transport) return
    const threads = await this.listAllThreads()
    this.patch({ threads })
  }

  goHome() {
    this.nav += 1
    const leaving = this.activeThreadId
    const streaming = this.snapshot.streaming
    this.activeThreadId = null
    if (leaving) void this.unsubscribeThread(leaving, streaming)
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

  private async unsubscribeThread(id: string, streaming: boolean) {
    const run = async () => {
      if (streaming) {
        try {
          await this.rpc('turn/interrupt', { threadId: id })
        } catch {
          // idle threads may reject interrupt
        }
      }
      try {
        await this.rpc('thread/unsubscribe', { threadId: id })
      } catch {
        // already closed
      }
    }
    this.leaveInFlight = this.leaveInFlight.then(run, run)
    await this.leaveInFlight
  }

  private async leaveThread() {
    const id = this.activeThreadId
    const streaming = this.snapshot.streaming
    this.activeThreadId = null
    if (!id) return
    await this.unsubscribeThread(id, streaming)
  }

  async openThread(threadId: string) {
    this.nav += 1
    const token = this.nav
    const run = () => this.openThreadInner(threadId, token)
    this.openInFlight = this.openInFlight.then(run, run)
    await this.openInFlight
  }

  private async openThreadInner(threadId: string, token: number) {
    if (token !== this.nav) return
    await this.leaveInFlight
    if (token !== this.nav) return
    const previousId = this.activeThreadId
    try {
      if (previousId && previousId !== threadId) {
        await this.leaveThread()
      }
      if (token !== this.nav) return
      this.activeThreadId = threadId
      const resumed = await this.rpc<ThreadResumeResponse>('thread/resume', {
        threadId,
        excludeTurns: true,
        initialTurnsPage: { limit: 80, sortDirection: 'desc', itemsView: 'full' },
      })
      if (token !== this.nav) {
        await this.unsubscribeThread(resumed.thread.id, false)
        return
      }
      const page = resumed.initialTurnsPage
      let turns: Turn[] = []
      let olderTurnsCursor = page?.backwardsCursor ?? resumed.turnsBackwardsCursor
      if (page?.data.length) {
        turns = [...page.data].reverse()
      } else {
        const listed = await this.listTurns(resumed.thread.id)
        if (token !== this.nav) {
          await this.unsubscribeThread(resumed.thread.id, false)
          return
        }
        turns = listed.turns
        olderTurnsCursor = listed.cursor ?? olderTurnsCursor
      }
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
        olderTurnsCursor,
        loadingOlder: false,
      })
    } catch (error) {
      if (token !== this.nav) return
      const keepCurrent = previousId === threadId ? previousId : null
      this.activeThreadId = keepCurrent
      this.patch({
        error: formatCodexError(error instanceof Error ? error.message : String(error)),
        ...(keepCurrent
          ? {}
          : {
              route: { kind: 'home' as const },
              title: 'Docs',
              blocks: [],
              streaming: false,
              olderTurnsCursor: null,
              loadingOlder: false,
            }),
      })
    }
  }

  private async listTurns(threadId: string): Promise<{ turns: Turn[]; cursor: string | null }> {
    try {
      const page = await this.rpc<TurnsPage>('thread/turns/list', {
        threadId,
        limit: 80,
        sortDirection: 'desc',
        itemsView: 'full',
      })
      return { turns: [...page.data].reverse(), cursor: page.backwardsCursor }
    } catch {
      return { turns: [], cursor: null }
    }
  }

  async loadOlderTurns() {
    const threadId = this.activeThreadId
    const cursor = this.snapshot.olderTurnsCursor
    const token = this.nav
    if (!threadId || !cursor || this.snapshot.loadingOlder) return
    this.patch({ loadingOlder: true })
    try {
      const page = await this.rpc<TurnsPage>('thread/turns/list', {
        threadId,
        cursor,
        limit: 80,
        sortDirection: 'desc',
        itemsView: 'full',
      })
      if (token !== this.nav || this.activeThreadId !== threadId) {
        this.patch({ loadingOlder: false })
        return
      }
      this.patch({
        blocks: mergeOlderBlocks(blocksFromTurns([...page.data].reverse()), this.snapshot.blocks),
        olderTurnsCursor: page.backwardsCursor,
        loadingOlder: false,
      })
    } catch (error) {
      if (token !== this.nav) {
        this.patch({ loadingOlder: false })
        return
      }
      this.patch({
        loadingOlder: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async newDocument() {
    this.nav += 1
    const token = this.nav
    const run = () => this.newDocumentInner(token)
    this.openInFlight = this.openInFlight.then(run, run)
    await this.openInFlight
  }

  private async newDocumentInner(token: number) {
    if (token !== this.nav) return
    try {
      await this.leaveInFlight
      if (token !== this.nav) return
      if (this.activeThreadId) await this.leaveThread()
      if (token !== this.nav) return
      const started = await this.rpc<ThreadStartResponse>('thread/start', {
        cwd: this.snapshot.cwd,
        model: this.snapshot.model,
      })
      if (token !== this.nav) {
        await this.unsubscribeThread(started.thread.id, false)
        return
      }
      this.activeThreadId = started.thread.id
      this.patch({
        route: { kind: 'doc', threadId: started.thread.id },
        title: 'Untitled document',
        blocks: [],
        cwd: typeof started.cwd === 'string' ? started.cwd : this.snapshot.cwd,
        model: started.model || this.snapshot.model,
        effort: started.reasoningEffort ?? this.snapshot.effort,
        streaming: false,
        error: null,
        olderTurnsCursor: null,
        loadingOlder: false,
      })
      await this.refreshCatalog()
    } catch (error) {
      if (token !== this.nav) return
      this.activeThreadId = null
      this.patch({
        error: formatCodexError(error instanceof Error ? error.message : String(error)),
        route: { kind: 'home' },
        title: 'Docs',
        blocks: [],
        streaming: false,
        olderTurnsCursor: null,
        loadingOlder: false,
      })
    }
  }

  async send(text: string) {
    const threadId = this.activeThreadId
    if (!threadId || this.snapshot.streaming) return
    const trimmed = text.trim()
    if (!trimmed) return
    const userItem: ThreadItem = {
      type: 'userMessage',
      id: `local-${Date.now()}`,
      clientId: null,
      content: [{ type: 'text', text: trimmed, text_elements: [] }],
    }
    const userBlock = itemToBlock(userItem)
    this.patch({
      blocks: userBlock ? [...this.snapshot.blocks, userBlock] : this.snapshot.blocks,
      streaming: true,
      error: null,
    })
    try {
      await this.rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text: trimmed, text_elements: [] }],
        ...this.turnOverrides(),
      })
    } catch (error) {
      this.patch({
        streaming: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private turnOverrides() {
    const preset = this.snapshot.collaborationModes.find(
      (item) => item.name === this.snapshot.collaborationMode,
    )
    if (preset?.mode) {
      return {
        collaborationMode: {
          mode: preset.mode,
          settings: {
            model: preset.model ?? this.snapshot.model ?? '',
            reasoning_effort: preset.reasoning_effort ?? null,
            developer_instructions: null,
          },
        },
      }
    }
    return {
      model: this.snapshot.model,
      effort: this.snapshot.effort,
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

  async setDocumentName(name: string) {
    const threadId = this.activeThreadId
    const trimmed = name.trim()
    if (!threadId || !trimmed || trimmed === this.snapshot.title) return
    try {
      await this.rpc('thread/name/set', { threadId, name: trimmed })
      this.patch({
        title: trimmed,
        threads: this.snapshot.threads.map((thread) =>
          thread.id === threadId ? { ...thread, name: trimmed } : thread,
        ),
      })
    } catch (error) {
      this.patch({ error: error instanceof Error ? error.message : String(error) })
    }
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
      this.openUrlFn(result.authUrl)
    }
  }

  async connectMcp(name: string) {
    try {
      const result = await this.rpc<McpServerOauthLoginResponse>('mcpServer/oauth/login', { name })
      this.patch({ loginUrl: result.authorizationUrl, error: null })
      this.openUrlFn(result.authorizationUrl)
    } catch (error) {
      this.patch({ error: error instanceof Error ? error.message : String(error) })
    }
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
    const block = this.snapshot.blocks.find((item) => item.id === blockId)
    if (!block || block.kind !== 'approval' || block.resolved !== null || !this.transport) return
    this.transport.respond(block.requestId, approvalResult(block, accept))
    this.patch({
      blocks: this.snapshot.blocks.map((item) =>
        item.id === blockId ? { ...item, resolved: accept ? 'accepted' : 'skipped' } : item,
      ),
    })
    if (block.method === 'mcpServer/elicitation/request') {
      const params = block.extra as McpServerElicitationRequestParams | undefined
      if (params?.threadId) {
        void this.rpc('thread/decrement_elicitation', { threadId: params.threadId }).catch(() => {})
      }
    }
  }

  private async onNotification(method: string, params: unknown) {
    const threadId = (params as { threadId?: string } | null)?.threadId
    if (threadId && (!this.activeThreadId || threadId !== this.activeThreadId)) {
      if (
        method !== 'account/updated' &&
        method !== 'account/login/completed' &&
        method !== 'account/rateLimits/updated' &&
        method !== 'project/changed' &&
        method !== 'mcpServer/oauthLogin/completed' &&
        method !== 'mcpServer/startupStatus/updated'
      ) {
        return
      }
    }

    if (method === 'item/agentMessage/delta') {
      const delta = params as { itemId: string; delta: string }
      this.patch({
        blocks: upsertAgentDelta(this.snapshot.blocks, delta.itemId, delta.delta),
        streaming: true,
      })
      return
    }
    if (method === 'item/plan/delta') {
      // Plans stay off the page (outputs only).
      return
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      // Reasoning stays off the page (outputs only).
      return
    }
    if (method === 'item/commandExecution/outputDelta') {
      const delta = params as { itemId: string; delta: string }
      this.patch({
        blocks: upsertCalloutDelta(this.snapshot.blocks, delta.itemId, 'Running a command', delta.delta),
      })
      return
    }
    if (method === 'turn/diff/updated') {
      const diff = params as { turnId: string; diff: string }
      this.patch({
        blocks: upsertCalloutReplace(this.snapshot.blocks, `diff-${diff.turnId}`, 'Changes', diff.diff),
      })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = (params as { item: ThreadItem }).item
      this.patch({ blocks: upsertItem(this.snapshot.blocks, item) })
      return
    }
    if (method === 'turn/completed') {
      const completed = params as TurnCompletedNotification
      this.patch({
        streaming: false,
        error:
          completed.turn.status === 'failed' && completed.turn.error
            ? completed.turn.error.message
            : this.snapshot.error,
      })
      return
    }
    if (method === 'error') {
      const failed = params as ErrorNotification
      this.patch({
        streaming: failed.willRetry ? this.snapshot.streaming : false,
        error: failed.error.message,
      })
      return
    }
    if (method === 'warning' || method === 'guardianWarning') {
      const warning = params as WarningNotification
      this.patch({ error: warning.message })
      return
    }
    if (method === 'configWarning') {
      const warning = params as { summary?: string }
      if (warning.summary) this.patch({ error: warning.summary })
      return
    }
    if (method === 'account/rateLimits/updated') {
      const update = params as AccountRateLimitsUpdatedNotification
      this.patch({
        rateLimits: this.snapshot.rateLimits
          ? { ...this.snapshot.rateLimits, rateLimits: update.rateLimits }
          : { rateLimits: update.rateLimits, rateLimitsByLimitId: null, rateLimitResetCredits: null },
      })
      return
    }
    if (method === 'serverRequest/resolved') {
      const resolved = params as ServerRequestResolvedNotification
      this.patch({
        blocks: this.snapshot.blocks.map((block) =>
          block.kind === 'approval' && String(block.requestId) === String(resolved.requestId)
            ? { ...block, resolved: block.resolved ?? 'skipped' }
            : block,
        ),
      })
      return
    }
    if (method === 'thread/name/updated') {
      const name = (params as { threadName?: string }).threadName
      if (name) this.patch({ title: name })
      return
    }
    if (method === 'thread/closed' || method === 'thread/deleted' || method === 'thread/archived') {
      const closedId = (params as { threadId?: string }).threadId
      if (closedId && closedId === this.activeThreadId) {
        this.activeThreadId = null
        this.patch({
          route: { kind: 'home' },
          title: 'Docs',
          blocks: [],
          streaming: false,
          olderTurnsCursor: null,
          error: 'This document is no longer available.',
        })
      }
      void this.refreshCatalog()
      return
    }
    if (method === 'account/updated' || method === 'account/login/completed') {
      this.patch({ loginUrl: null })
      await this.refreshCatalog()
      return
    }
    if (method === 'project/changed' || method === 'mcpServer/oauthLogin/completed') {
      if (method === 'mcpServer/oauthLogin/completed') this.patch({ loginUrl: null })
      await this.refreshCatalog()
    }
  }

  private onServerRequest(request: { id: JsonRpcId; method: string; params: unknown }) {
    if (request.method === 'currentTime/read') {
      this.transport?.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) })
      return
    }
    if (request.method === 'account/chatgptAuthTokens/refresh') {
      void this.refreshChatgptTokens(request.id)
      return
    }
    if (request.method === 'item/tool/call') {
      this.transport?.respond(request.id, {
        contentItems: [{ type: 'inputText', text: 'This Docs window does not host that tool.' }],
        success: false,
      })
      return
    }
    if (request.method === 'attestation/generate') {
      this.transport?.reject(request.id, 'attestation is not enabled')
      return
    }
    const approval = approvalFromRequest(request)
    if (approval) {
      this.patch({ blocks: [...this.snapshot.blocks, approval] })
      if (request.method === 'mcpServer/elicitation/request') {
        const params = request.params as McpServerElicitationRequestParams
        void this.rpc('thread/increment_elicitation', { threadId: params.threadId }).catch(() => {})
        if (params.mode === 'url') {
          this.patch({ loginUrl: params.url })
          this.openUrlFn(params.url)
        }
      }
      return
    }
    this.transport?.reject(request.id, `unhandled ${request.method}`)
  }

  private async refreshChatgptTokens(id: JsonRpcId) {
    try {
      await this.rpc('account/read', { refreshToken: true })
    } catch {
      // file on disk may still be valid
    }
    const tokens = readCodexAuthTokens()
    if (tokens) {
      this.transport?.respond(id, tokens)
      return
    }
    this.transport?.reject(id, 'Codex-managed ChatGPT auth has no refreshable tokens')
    this.patch({ requiresAuth: true, error: 'Sign in with ChatGPT to refresh this session.' })
  }
}

function defaultOpenUrl(url: string) {
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
}

export { formatCodexError } from './labels'

export function readCodexAuthTokens(): ChatgptAuthTokensRefreshResponse | null {
  const home = process.env.CODEX_HOME ?? `${process.env.HOME ?? ''}/.codex`
  try {
    const raw = JSON.parse(readFileSync(`${home}/auth.json`, 'utf8')) as {
      tokens?: { access_token?: unknown; account_id?: unknown }
    }
    const accessToken = raw.tokens?.access_token
    const chatgptAccountId = raw.tokens?.account_id
    if (typeof accessToken === 'string' && typeof chatgptAccountId === 'string') {
      return { accessToken, chatgptAccountId, chatgptPlanType: null }
    }
  } catch {
    return null
  }
  return null
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

function upsertCalloutDelta(blocks: Block[], itemId: string, title: string, delta: string): Block[] {
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

function upsertCalloutReplace(blocks: Block[], itemId: string, title: string, body: string): Block[] {
  const index = blocks.findIndex((block) => block.id === itemId)
  if (index === -1) return [...blocks, { kind: 'callout', id: itemId, title, body }]
  const next = blocks.slice()
  const current = next[index]
  next[index] = current.kind === 'callout' ? { ...current, body } : { kind: 'callout', id: itemId, title, body }
  return next
}

function upsertItem(blocks: Block[], item: ThreadItem): Block[] {
  const next = itemToBlock(item)
  // Hidden items (reasoning, plans) never touch the page.
  if (!next) return blocks
  const index = blocks.findIndex((block) => block.id === item.id)
  if (index === -1) {
    // The optimistic user echo (local-* id) is replaced by the server-echoed
    // item with the same text, so a sent message never appears twice.
    if (next.kind === 'user') {
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'user' && last.id.startsWith('local-') && last.text === next.text) {
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

function approvalFromRequest(request: {
  id: JsonRpcId
  method: string
  params: unknown
}): PendingApproval | null {
  if (request.method === 'execCommandApproval' || request.method === 'item/commandExecution/requestApproval') {
    const params = request.params as CommandExecutionRequestApprovalParams & {
      command?: string | string[]
      reason?: string | null
    }
    const command = Array.isArray(params.command) ? params.command.join(' ') : params.command
    return {
      kind: 'approval',
      id: `approval-${String(request.id)}`,
      requestId: request.id,
      method: request.method,
      title: 'Run command?',
      body: command ?? params.reason ?? 'Command',
      resolved: null,
      drafts: {},
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
      drafts: {},
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
      drafts: {},
    }
  }
  if (request.method === 'mcpServer/elicitation/request') {
    const params = request.params as McpServerElicitationRequestParams
    const drafts: Record<string, string> = {}
    const properties = elicitationProperties(params)
    for (const [key, schema] of Object.entries(properties)) {
      if (schema && typeof schema === 'object' && 'default' in schema && schema.default != null) {
        drafts[key] = String(schema.default)
      }
    }
    return {
      kind: 'approval',
      id: `approval-${String(request.id)}`,
      requestId: request.id,
      method: request.method,
      title: `Continue with ${params.serverName}?`,
      body: params.message,
      resolved: null,
      extra: params,
      drafts,
    }
  }
  if (request.method === 'item/tool/requestUserInput') {
    const params = request.params as ToolRequestUserInputParams
    return {
      kind: 'approval',
      id: `approval-${String(request.id)}`,
      requestId: request.id,
      method: request.method,
      title: 'The assistant needs input',
      body: params.questions.map((question) => question.question).filter(Boolean).join('\n') || 'Continue?',
      resolved: null,
      extra: params,
      drafts: {},
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
      scope: 'turn',
    }
  }
  if (block.method === 'mcpServer/elicitation/request') {
    const params = block.extra as McpServerElicitationRequestParams
    if (!accept) return { action: 'cancel', content: null, _meta: null }
    const content =
      params.mode === 'form' || params.mode === 'openai/form' ? { ...block.drafts } : null
    return { action: 'accept', content, _meta: null }
  }
  if (block.method === 'execCommandApproval' || block.method === 'applyPatchApproval') {
    return accept ? { decision: 'approved' } : { decision: { denied: { rejection: 'skipped' } } }
  }
  if (block.method === 'item/tool/requestUserInput') {
    const params = block.extra as ToolRequestUserInputParams
    const answers: Record<string, { answers: string[] }> = {}
    if (accept) {
      for (const question of params.questions) {
        const value = block.drafts[question.id] ?? ''
        answers[question.id] = { answers: value ? [value] : [] }
      }
    }
    return { answers }
  }
  return {}
}

export { accountLabel, formFields, inputQuestions } from './labels'
