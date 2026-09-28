import {
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  type PermissionResult,
  type Query,
  type SDKSessionInfo,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import type { PendingApproval, UserBlock } from '../codex/blocks'
import { emptySnapshot, type Snapshot } from '../codex/types'
import type { NewDocumentOptions, SendExtras } from '../shared/api'
import { Inbox } from './inbox'
import { applyStreamMessage, blocksFromSessionMessages, toModel, toSkills, toThread, type StreamState } from './mapping'

export type { Snapshot } from '../codex/types'

/** The Agent SDK surface this session uses; tests swap in a fake. */
export type ClaudeSdk = {
  query: typeof query
  listSessions: typeof listSessions
  getSessionMessages: typeof getSessionMessages
  renameSession: typeof renameSession
}

const realSdk: ClaudeSdk = { query, listSessions, getSessionMessages, renameSession }
const homeDir = () => process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
const SIGN_IN = 'Claude signs in outside Docs — run `claude` in a terminal and log in, then Tools → Refresh.'
const IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

type Live = { id: string; query: Query; inbox: Inbox<SDKUserMessage>; state: StreamState; named: boolean }

/**
 * A CodexSession-compatible session backed by the Claude Agent SDK, which
 * runs Anthropic's unmodified Claude Code binary with the person's own
 * Claude login. Docs never reads, stores, or offers Claude credentials.
 */
export class ClaudeSession {
  snapshot: Snapshot = { ...emptySnapshot(homeDir()), provider: 'claude' }
  private listeners = new Set<() => void>()
  private sessions: SDKSessionInfo[] = []
  private live: Live | null = null
  private permissions = new Map<string, (result: PermissionResult) => void>()
  private pendingTitle: string | null = null
  private nav = 0

  constructor(private readonly sdk: ClaudeSdk = realSdk) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot

  private patch(partial: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...partial }
    for (const listener of this.listeners) listener()
  }

  private fail(error: unknown) {
    this.patch({ error: error instanceof Error ? error.message : String(error) })
  }

  async start() {
    await this.refreshCatalog()
    this.patch({ status: this.snapshot.status === 'error' ? 'error' : 'ready' })
  }

  async close() {
    this.endLive()
  }

  async refreshCatalog() {
    try {
      this.sessions = await this.sdk.listSessions({ limit: 300 })
      this.patch({ threads: this.filtered(), error: null })
      if (!this.snapshot.models.length) void this.loadModels()
    } catch (error) {
      this.patch({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Models and skills come from a Claude Code process; a short idle one answers before any doc opens. */
  private async loadModels() {
    const inbox = new Inbox<SDKUserMessage>()
    const probe = this.sdk.query({ prompt: inbox, options: { cwd: this.cwd() } })
    try {
      const [models, commands] = await Promise.all([probe.supportedModels(), probe.supportedCommands()])
      const mapped = models.map(toModel)
      const model = this.snapshot.model ?? mapped.find((item) => item.isDefault)?.model ?? mapped[0]?.model ?? null
      this.patch({
        models: mapped,
        model,
        effort: this.snapshot.effort ?? mapped.find((item) => item.model === model)?.defaultReasoningEffort ?? null,
        skills: toSkills(commands),
      })
    } catch (error) {
      this.patch({ error: `${error instanceof Error ? error.message : String(error)} ${SIGN_IN}` })
    } finally {
      probe.close()
      inbox.end()
    }
  }

  private cwd(): string {
    return existsSync(this.snapshot.cwd) ? this.snapshot.cwd : homeDir()
  }

  private filtered() {
    const search = this.snapshot.search.trim().toLowerCase()
    return this.sessions
      .filter(
        (info) =>
          !search ||
          `${info.customTitle ?? ''} ${info.summary} ${info.firstPrompt ?? ''}`.toLowerCase().includes(search),
      )
      .map(toThread)
  }

  setSearch(value: string) {
    this.patch({ search: value })
  }

  async applySearch() {
    this.patch({ threads: this.filtered() })
  }

  private startLive(id: string, cwd: string, resume: boolean): Live {
    this.endLive()
    const inbox = new Inbox<SDKUserMessage>()
    const live: Live = {
      id,
      inbox,
      state: { messageId: null, streamed: new Set() },
      named: resume,
      query: this.sdk.query({
        prompt: inbox,
        options: {
          cwd,
          ...(resume ? { resume: id } : { sessionId: id }),
          model: this.snapshot.model ?? undefined,
          includePartialMessages: true,
          // Docs has no dialog for Claude's multiple-choice questions; it asks in plain text instead.
          disallowedTools: ['AskUserQuestion'],
          canUseTool: (tool, input, { signal, title }) => this.askPermission(live, tool, input, signal, title),
        },
      }),
    }
    this.live = live
    void this.consume(live)
    // Project skills depend on the folder, so each document asks its own process.
    void live.query
      .supportedCommands()
      .then((commands) => {
        if (this.live === live) this.patch({ skills: toSkills(commands) })
      })
      .catch(() => {})
    return live
  }

  private async consume(live: Live) {
    try {
      for await (const message of live.query) {
        if (this.live !== live) return
        const update = applyStreamMessage(this.snapshot.blocks, message, live.state)
        if (update.done) {
          this.patch({ blocks: update.blocks, streaming: false, error: update.error ?? null })
          void this.afterTurn(live)
        } else if (update.blocks !== this.snapshot.blocks) {
          this.patch({ blocks: update.blocks, streaming: true })
        }
      }
    } catch (error) {
      if (this.live === live)
        this.patch({ streaming: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The first finished turn creates the transcript, so a pending title and the home list catch up here. */
  private async afterTurn(live: Live) {
    if (!live.named && this.pendingTitle) {
      live.named = true
      await this.sdk.renameSession(live.id, this.pendingTitle).catch(() => {})
      this.pendingTitle = null
    }
    await this.refreshCatalog()
  }

  private endLive() {
    const live = this.live
    this.live = null
    for (const resolve of this.permissions.values()) resolve({ behavior: 'deny', message: 'Document closed.' })
    this.permissions.clear()
    if (!live) return
    live.inbox.end()
    live.query.close()
  }

  private askPermission(
    live: Live,
    tool: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    title?: string,
  ): Promise<PermissionResult> {
    const id = `permission-${randomUUID()}`
    const block: PendingApproval = {
      kind: 'approval',
      id,
      requestId: id,
      method: 'claude/canUseTool',
      title: title ?? `Allow ${tool}?`,
      body:
        typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : '',
      resolved: null,
      drafts: {},
    }
    if (this.live === live) this.patch({ blocks: [...this.snapshot.blocks, block] })
    return new Promise((resolve) => {
      this.permissions.set(id, resolve)
      signal.addEventListener('abort', () => {
        this.permissions.delete(id)
        this.markApproval(id, 'skipped')
      })
    })
  }

  private markApproval(id: string, resolved: 'accepted' | 'skipped') {
    this.patch({
      blocks: this.snapshot.blocks.map((block) =>
        block.kind === 'approval' && block.id === id ? { ...block, resolved } : block,
      ),
    })
  }

  resolveApproval(blockId: string, accept: boolean) {
    const resolve = this.permissions.get(blockId)
    if (!resolve) return
    this.permissions.delete(blockId)
    resolve(accept ? { behavior: 'allow' } : { behavior: 'deny', message: 'The person skipped this step.' })
    this.markApproval(blockId, accept ? 'accepted' : 'skipped')
  }

  setApprovalDraft(_blockId: string, _key: string, _value: string) {}

  goHome() {
    this.nav += 1
    this.endLive()
    this.pendingTitle = null
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

  async openThread(threadId: string) {
    this.nav += 1
    const token = this.nav
    this.patch({ openingThreadId: threadId, error: null })
    const info = this.sessions.find((item) => item.sessionId === threadId)
    try {
      const messages = await this.sdk.getSessionMessages(threadId)
      if (token !== this.nav) return
      const cwd = info?.cwd && existsSync(info.cwd) ? info.cwd : this.cwd()
      this.startLive(threadId, cwd, true)
      this.patch({
        route: { kind: 'doc', threadId },
        title: info ? toThread(info).name || 'Untitled document' : 'Untitled document',
        blocks: blocksFromSessionMessages(messages),
        cwd,
        streaming: false,
        error: null,
        olderTurnsCursor: null,
        loadingOlder: false,
        openingThreadId: null,
      })
    } catch (error) {
      if (token !== this.nav) return
      this.fail(error)
      this.patch({ openingThreadId: null, route: { kind: 'home' } })
    }
  }

  async newDocument(options?: NewDocumentOptions) {
    this.nav += 1
    const id = randomUUID()
    const cwd = options?.cwd && existsSync(options.cwd) ? options.cwd : options ? homeDir() : this.cwd()
    this.startLive(id, cwd, false)
    this.pendingTitle = options?.title?.trim() || null
    this.patch({
      route: { kind: 'doc', threadId: id },
      title: this.pendingTitle ?? 'Untitled document',
      blocks: [],
      cwd,
      streaming: false,
      error: null,
      olderTurnsCursor: null,
      loadingOlder: false,
      openingThreadId: null,
    })
  }

  async send(text: string, extras: SendExtras = {}) {
    const live = this.live
    if (!live || this.snapshot.streaming) return
    const trimmed = text.trim()
    const images = extras.images ?? []
    const skill = this.snapshot.skills.find((item) => item.name === extras.skill)?.name
    if (!trimmed && images.length === 0 && !skill) return
    const echo: UserBlock = { kind: 'user', id: `local-${Date.now()}`, text: trimmed }
    if (images.length) echo.images = images
    if (skill) echo.skills = [skill]
    this.patch({ blocks: [...this.snapshot.blocks, echo], streaming: true, error: null })
    try {
      // Claude Code expands a leading /name into that skill, as it does when typed in the terminal.
      const prompt = skill ? `/${skill} ${trimmed}`.trim() : trimmed
      const pictures = await Promise.all(images.map(imageBlock))
      live.inbox.push({
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: [...pictures, ...(prompt ? [{ type: 'text' as const, text: prompt }] : [])] },
      })
    } catch (error) {
      this.patch({ streaming: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async interrupt() {
    await this.live?.query.interrupt().catch(() => undefined)
    this.patch({ streaming: false })
  }

  setModel(model: string) {
    const entry = this.snapshot.models.find((item) => item.model === model)
    this.patch({ model, effort: entry?.defaultReasoningEffort ?? this.snapshot.effort })
    void this.live?.query.setModel(model).catch((error: unknown) => this.fail(error))
  }

  setEffort(effort: string) {
    this.patch({ effort })
    const effortLevel = effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    void this.live?.query.applyFlagSettings({ effortLevel }).catch((error: unknown) => this.fail(error))
  }

  setServiceTier(_serviceTier: string | null) {}
  setCollaborationMode(_name: string) {}

  async setDocumentName(name: string) {
    const trimmed = name.trim()
    const live = this.live
    if (!live || !trimmed || trimmed === this.snapshot.title) return
    this.patch({ title: trimmed })
    // Before the first message there is no transcript to rename yet.
    if (!live.named) {
      this.pendingTitle = trimmed
      return
    }
    try {
      await this.sdk.renameSession(live.id, trimmed)
      await this.refreshCatalog()
    } catch (error) {
      this.fail(error)
    }
  }

  async loadOlderTurns() {}

  async createProject(_name: string, _cwd: string) {
    throw new Error('Claude files documents by folder. Choose a folder when you create a document.')
  }

  toggleFolder(show: boolean) {
    this.patch({ showFolder: show, folderDraft: this.snapshot.cwd })
  }

  setFolderDraft(value: string) {
    this.patch({ folderDraft: value })
  }

  applyFolder() {
    const cwd = this.snapshot.folderDraft.trim() || homeDir()
    this.patch({ cwd, showFolder: false, folderDraft: cwd })
  }

  async login() {
    this.patch({ error: SIGN_IN })
  }

  async logout() {
    this.patch({ error: 'Claude signs out outside Docs — run `claude` in a terminal and use /logout.' })
  }

  async connectMcp(_name: string) {
    this.patch({ error: 'Manage Claude tools with `claude mcp` in a terminal.' })
  }
}

async function imageBlock(path: string) {
  const media_type = IMAGE_TYPES[extname(path).toLowerCase()] ?? 'image/png'
  const data = (await readFile(path)).toString('base64')
  return { type: 'image' as const, source: { type: 'base64' as const, media_type, data } }
}
