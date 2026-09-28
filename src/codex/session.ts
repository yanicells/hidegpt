import type { NewDocumentOptions, SendExtras } from '../shared/api'
import { spawn } from 'node:child_process'

import type { LoginAccountResponse } from '../generated/codex/v2/LoginAccountResponse'
import type { McpServerOauthLoginResponse } from '../generated/codex/v2/McpServerOauthLoginResponse'
import type { ThreadResumeResponse } from '../generated/codex/v2/ThreadResumeResponse'
import type { ThreadStartResponse } from '../generated/codex/v2/ThreadStartResponse'
import type { Turn } from '../generated/codex/v2/Turn'
import type { UserInput } from '../generated/codex/v2/UserInput'

import * as approvals from './approvals'
import { blocksFromTurns, itemToBlock } from './blocks'
import * as catalog from './catalog'
import type { JsonRpcId } from './jsonrpc'
import { formatCodexError } from './labels'
import * as stream from './stream'
import { spawnCodexAppServer, type CodexTransport } from './transport'
import { emptySnapshot, type SessionCtx, type Snapshot } from './types'

export type { Route, Snapshot } from './types'

export class CodexSession {
  snapshot: Snapshot = emptySnapshot(catalog.defaultCwd())
  private listeners = new Set<() => void>()
  private transport: CodexTransport | null = null
  private unsubNote: (() => void) | null = null
  private unsubReq: (() => void) | null = null
  private activeThreadId: string | null = null
  private leaveQueue: Promise<void> = Promise.resolve()
  private openQueue: Promise<void> = Promise.resolve()
  private nav = 0
  private closing = false

  constructor(
    private readonly createTransport: () => CodexTransport = spawnCodexAppServer,
    private readonly openUrlFn: (url: string) => void = defaultOpenUrl,
  ) {}

  private get ctx(): SessionCtx {
    return {
      patch: (partial) => this.patch(partial),
      rpc: <T>(method: string, params?: unknown): Promise<T> => this.rpc<T>(method, params),
      getSnapshot: () => this.snapshot,
      getActiveId: () => this.activeThreadId,
      setActiveId: (id) => {
        this.activeThreadId = id
      },
      guard: (token) => token === this.nav,
      respond: (id, result) => this.transport?.respond(id, result),
      reject: (id, message) => this.transport?.reject(id, message),
      openUrl: (url) => this.openUrlFn(url),
    }
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

  async start() {
    this.closing = false
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
        if (!this.closing) {
          this.patch({ status: 'error', error: 'Codex disconnected. File → Refresh to reconnect.', streaming: false })
        }
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
    this.closing = true
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

  refreshCatalog() {
    return catalog.refreshCatalog(this.ctx)
  }

  setSearch(value: string) {
    catalog.setSearch(this.ctx, value)
  }

  async applySearch() {
    if (!this.transport) return
    await catalog.applySearch(this.ctx)
  }

  setDocumentName(name: string) {
    return catalog.setDocumentName(this.ctx, name)
  }

  toggleFolder(show: boolean) {
    catalog.toggleFolder(this.ctx, show)
  }

  setFolderDraft(value: string) {
    catalog.setFolderDraft(this.ctx, value)
  }

  applyFolder() {
    const previousCwd = this.snapshot.cwd
    catalog.applyFolder(this.ctx)
    this.refreshSkillsIfMoved(previousCwd)
  }

  /** Repo-scoped skills depend on the folder, so a new folder means a new list. */
  private refreshSkillsIfMoved(previousCwd: string) {
    if (this.snapshot.cwd !== previousCwd) void catalog.refreshSkills(this.ctx)
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
      openingThreadId: null,
    })
  }

  setModel(model: string) {
    const entry = this.snapshot.models.find((item) => item.model === model)
    this.patch({
      model,
      effort: entry?.defaultReasoningEffort ?? this.snapshot.effort,
      // Tiers belong to the model; a new model starts on the thread default.
      serviceTier: null,
    })
  }

  setEffort(effort: string) {
    this.patch({ effort })
  }

  setServiceTier(serviceTier: string | null) {
    this.patch({ serviceTier })
  }

  setCollaborationMode(name: string) {
    this.patch({ collaborationMode: name })
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
    this.leaveQueue = this.leaveQueue.then(run, run)
    await this.leaveQueue
  }

  private async leaveThread() {
    const id = this.activeThreadId
    const streaming = this.snapshot.streaming
    this.activeThreadId = null
    if (!id) return
    await this.unsubscribeThread(id, streaming)
  }

  async openThread(threadId: string) {
    this.patch({ openingThreadId: threadId, error: null })
    this.nav += 1
    const token = this.nav
    const run = () => this.openThreadInner(threadId, token)
    this.openQueue = this.openQueue.then(run, run)
    await this.openQueue
  }

  private async openThreadInner(threadId: string, token: number) {
    if (token !== this.nav) return
    await this.leaveQueue
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
        initialTurnsPage: { limit: 30, sortDirection: 'desc', itemsView: 'full' },
      })
      if (token !== this.nav) {
        await this.unsubscribeThread(resumed.thread.id, false)
        return
      }
      const page = resumed.initialTurnsPage
      let turns: Turn[] = []
      let olderTurnsCursor = page?.backwardsCursor ?? resumed.turnsBackwardsCursor
      if (page) {
        turns = [...page.data].reverse()
      } else {
        const listed = await catalog.listTurns(this.ctx, resumed.thread.id)
        if (token !== this.nav) {
          await this.unsubscribeThread(resumed.thread.id, false)
          return
        }
        turns = listed.turns
        olderTurnsCursor = listed.cursor ?? olderTurnsCursor
      }
      this.activeThreadId = resumed.thread.id
      const title = resumed.thread.name?.trim() || resumed.thread.preview?.trim() || 'Untitled document'
      const previousCwd = this.snapshot.cwd
      this.patch({
        route: { kind: 'doc', threadId: resumed.thread.id },
        title,
        blocks: blocksFromTurns(turns),
        cwd: typeof resumed.cwd === 'string' ? resumed.cwd : this.snapshot.cwd,
        model: resumed.model || this.snapshot.model,
        effort: resumed.reasoningEffort ?? this.snapshot.effort,
        serviceTier: resumed.serviceTier ?? null,
        streaming: false,
        error: null,
        olderTurnsCursor,
        loadingOlder: false,
        openingThreadId: null,
      })
      this.refreshSkillsIfMoved(previousCwd)
    } catch (error) {
      if (token !== this.nav) return
      const keepCurrent = previousId === threadId ? previousId : null
      this.activeThreadId = keepCurrent
      this.patch({
        error: formatCodexError(error instanceof Error ? error.message : String(error)),
        openingThreadId: null,
        ...(keepCurrent
          ? {}
          : {
              route: { kind: 'home' as const },
              title: 'Docs',
              blocks: [],
              streaming: false,
              olderTurnsCursor: null,
              loadingOlder: false,
              openingThreadId: null,
            }),
      })
    }
  }

  async loadOlderTurns() {
    const token = this.nav
    return catalog.loadOlderTurns(this.ctx, token)
  }

  async createProject(name: string, cwd: string) {
    await catalog.createProject(this.ctx, name, cwd)
  }

  async newDocument(options?: NewDocumentOptions) {
    this.nav += 1
    const token = this.nav
    const run = () => this.newDocumentInner(token, options)
    this.openQueue = this.openQueue.then(run, run)
    await this.openQueue
  }

  private async newDocumentInner(token: number, options?: NewDocumentOptions) {
    if (token !== this.nav) return
    try {
      await this.leaveQueue
      if (token !== this.nav) return
      if (this.activeThreadId) await this.leaveThread()
      if (token !== this.nav) return
      const started = await this.rpc<ThreadStartResponse>('thread/start', {
        cwd: options?.cwd ?? (options ? catalog.defaultCwd() : this.snapshot.cwd),
        projectId: options?.projectId ?? null,
        model: this.snapshot.model,
        serviceTier: this.snapshot.serviceTier,
      })
      if (token !== this.nav) {
        await this.unsubscribeThread(started.thread.id, false)
        return
      }
      this.activeThreadId = started.thread.id
      const previousCwd = this.snapshot.cwd
      this.patch({
        route: { kind: 'doc', threadId: started.thread.id },
        title: 'Untitled document',
        blocks: [],
        cwd: typeof started.cwd === 'string' ? started.cwd : this.snapshot.cwd,
        model: started.model || this.snapshot.model,
        effort: started.reasoningEffort ?? this.snapshot.effort,
        serviceTier: started.serviceTier ?? null,
        streaming: false,
        error: null,
        olderTurnsCursor: null,
        loadingOlder: false,
        openingThreadId: null,
      })
      this.refreshSkillsIfMoved(previousCwd)
      if (options?.title?.trim()) await this.setDocumentName(options.title.trim())
      void catalog.refreshThreads(this.ctx).catch(() => {})
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
        openingThreadId: null,
      })
    }
  }

  async send(text: string, extras: SendExtras = {}) {
    const threadId = this.activeThreadId
    if (!threadId || this.snapshot.streaming) return
    const trimmed = text.trim()
    const images = extras.images ?? []
    const skill = this.snapshot.skills.find((item) => item.name === extras.skill)
    if (!trimmed && images.length === 0 && !skill) return
    const input: UserInput[] = [
      ...(trimmed ? [{ type: 'text' as const, text: trimmed, text_elements: [] }] : []),
      ...images.map((path) => ({ type: 'localImage' as const, path })),
      ...(skill ? [{ type: 'skill' as const, name: skill.name, path: skill.path }] : []),
    ]
    const userBlock = itemToBlock({ type: 'userMessage', id: `local-${Date.now()}`, clientId: null, content: input })
    this.patch({
      blocks: userBlock ? [...this.snapshot.blocks, userBlock] : this.snapshot.blocks,
      streaming: true,
      error: null,
    })
    try {
      await this.rpc('turn/start', { threadId, input, ...this.turnOverrides() })
    } catch (error) {
      this.patch({
        streaming: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private turnOverrides() {
    const preset = this.snapshot.collaborationModes.find((item) => item.name === this.snapshot.collaborationMode)
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
        serviceTierForTurn: this.snapshot.serviceTier,
      }
    }
    return {
      model: this.snapshot.model,
      effort: this.snapshot.effort,
      // Null inherits the thread's tier; a tier id applies to this turn only.
      serviceTierForTurn: this.snapshot.serviceTier,
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
    approvals.setApprovalDraft(this.ctx, blockId, key, value)
  }

  resolveApproval(blockId: string, accept: boolean) {
    if (!this.transport) return
    approvals.resolveApproval(this.ctx, blockId, accept)
  }

  private onNotification(method: string, params: unknown) {
    void stream.onNotification(this.ctx, method, params)
  }

  private onServerRequest(request: { id: JsonRpcId; method: string; params: unknown }) {
    stream.onServerRequest(this.ctx, request)
  }

  private refreshChatgptTokens(id: JsonRpcId) {
    void stream.refreshChatgptTokens(this.ctx, id)
  }
}

function defaultOpenUrl(url: string) {
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
}

export { formatCodexError } from './labels'
export { readCodexAuthTokens } from './stream'
