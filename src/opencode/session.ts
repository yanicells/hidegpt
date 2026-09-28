import * as approvals from './approvals'
import type { NewDocumentOptions, SendExtras } from '../shared/api'
import { existsSync } from 'node:fs'

import type { UserBlock } from '../codex/blocks'
import { emptySnapshot, type Snapshot } from '../codex/types'
import {
  startOpenCodeServer,
  type OpenCodeClient,
  type OpenCodeServer,
  type OpenEvent,
  type OpenPromptPart,
  type OpenSkill,
} from './client'
import { handleEvent } from './events'
import {
  blocksFromMessages,
  imagePart,
  messageText,
  skillPart,
  preferredDefault,
  sessionTitle,
  splitModelId,
  toCodexModel,
  toCodexProject,
  toCodexThread,
} from './mapping'

export type { Snapshot } from '../codex/types'

type ClientFactory = (cwd: string) => Promise<{ client: OpenCodeClient; version: string; close: () => Promise<void> }>

const defaultFactory: ClientFactory = (cwd) => startOpenCodeServer({ cwd })
const homeDir = () => process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()

/** A CodexSession-compatible session backed by `opencode serve` (REST + SSE). */
export class OpenCodeSession {
  snapshot: Snapshot = { ...emptySnapshot(homeDir()), provider: 'opencode' }
  private listeners = new Set<() => void>()
  private server: OpenCodeServer | null = null
  private createClient: ClientFactory
  private abortEvents: AbortController | null = null
  private activeSessionId: string | null = null
  private model: { providerID: string; modelID: string } | null = null
  private agent = 'build'
  private agents: string[] = []
  /** Full skill bodies stay here; the snapshot only carries names and descriptions. */
  private skillBodies = new Map<string, OpenSkill>()
  /** messageId -> partId -> accumulated text for the live turn. */
  private streamText = new Map<string, Map<string, string>>()
  private pendingLocalId: string | null = null
  private nav = 0

  constructor(createClient: ClientFactory = defaultFactory) {
    this.createClient = createClient
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot
  private emit() {
    for (const listener of this.listeners) listener()
  }
  private patch(partial: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...partial }
    this.emit()
  }
  private fail(error: unknown) {
    this.patch({ error: error instanceof Error ? error.message : String(error) })
  }
  private get client(): OpenCodeClient | null {
    return this.server?.client ?? null
  }

  async start() {
    if (this.server) return
    try {
      const cwd = this.snapshot.cwd
      this.server = await this.createClient(existsSync(cwd) ? cwd : process.cwd())
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
      client.subscribeEvents(
        (event) => this.onEvent(event),
        this.abortEvents.signal,
        () => void this.restoreConnection(),
        () => this.patch({ error: 'Updates interrupted. Use Stop, then Tools → Refresh to reconnect.' }),
      )
    } catch {
      // event stream failures surface on next user action; catalog still works
    }
  }

  private async restoreConnection() {
    const client = this.client
    const id = this.activeSessionId
    if (!client || !id) return
    try {
      const [messages, statuses] = await Promise.all([
        client.listMessages(id, Math.max(100, this.snapshot.blocks.length), this.snapshot.cwd),
        client.sessionStatuses(),
      ])
      if (this.activeSessionId !== id) return
      const approvals = this.snapshot.blocks.filter((block) => block.kind === 'approval')
      this.pendingLocalId = null
      this.streamText.clear()
      for (const message of messages) {
        if (message.info.role !== 'assistant') continue
        this.streamText.set(
          message.info.id,
          new Map(
            message.parts
              .filter((part) => part.type === 'text' && !part.synthetic)
              .map((part) => [part.id, part.text ?? '']),
          ),
        )
      }
      this.patch({
        blocks: [...blocksFromMessages(messages), ...approvals],
        error: null,
        streaming: Boolean(statuses[id] && statuses[id].type !== 'idle'),
      })
    } catch (error) {
      this.fail(error)
    }
  }

  async refreshCatalog() {
    this.subscribeToEvents()
    const client = this.client
    if (!client) return
    try {
      const [sessions, catalog, agents, projects] = await Promise.all([
        client.listSessions({ search: this.snapshot.search || undefined, limit: 100 }),
        client.listCatalog(),
        client.listAgents(),
        client.listProjects(),
        this.refreshSkills(),
      ])
      this.agents = agents
        .filter((agent) => agent.mode !== 'subagent' && agent.name.toLowerCase() !== 'plan')
        .map((agent) => agent.name)
      if (!this.agents.includes(this.agent))
        this.agent = this.agents.includes('build') ? 'build' : (this.agents[0] ?? 'build')
      const mappedModels = catalog.models.map(toCodexModel)
      if (!this.model) {
        const preferred = preferredDefault(
          catalog.defaults,
          catalog.models.map((m) => `${m.providerID}/${m.id}`),
        )
        const chosen = preferred ?? mappedModels.find((m) => m.isDefault)?.model ?? mappedModels[0]?.model ?? null
        this.model = chosen ? splitModelId(chosen) : null
      }
      this.patch({
        models: mappedModels,
        model: this.model ? `${this.model.providerID}/${this.model.modelID}` : null,
        effort: null,
        ...serviceTierReset,
        collaborationModes: agents
          .filter((agent) => agent.name.toLowerCase() !== 'plan' && agent.mode !== 'subagent')
          .map((agent) => ({ name: agent.name, mode: null, model: null, reasoning_effort: null })),
        collaborationMode: this.agent,
        projects: projects.map(toCodexProject),
        threads: sessions.map(toCodexThread),
        account: null,
        requiresAuth: false,
        rateLimits: null,
        mcpServers: [],
      })
    } catch (error) {
      this.fail(error)
    }
  }

  /** Skills depend on the folder (repo skills), so this reruns when cwd changes. */
  private async refreshSkills() {
    const client = this.client
    const cwd = this.snapshot.cwd
    if (!client) return
    try {
      const listed = await client.listSkills(cwd)
      if (this.snapshot.cwd !== cwd) return
      this.skillBodies = new Map(listed.map((skill) => [skill.name, skill]))
      this.patch({
        skills: listed
          .map((skill) => ({ name: skill.name, description: skill.description ?? '', path: skill.location }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      })
    } catch {
      // skills are optional; the composer just offers none
    }
  }

  setSearch(value: string) {
    this.patch({ search: value })
  }

  async applySearch() {
    if (!this.client) return
    try {
      const search = this.snapshot.search
      const sessions = await this.client.listSessions({ search: search || undefined, limit: 100 })
      if (this.snapshot.search === search) this.patch({ threads: sessions.map(toCodexThread) })
    } catch (error) {
      this.fail(error)
    }
  }

  goHome() {
    this.nav += 1
    this.abandonTurn()
    this.activeSessionId = null
    this.pendingLocalId = null
    this.streamText.clear()
    this.patch({
      openingThreadId: null,
      route: { kind: 'home' },
      title: 'Docs',
      blocks: [],
      streaming: false,
      olderTurnsCursor: null,
      loadingOlder: false,
    })
  }

  setModel(model: string) {
    if (!this.snapshot.models.some((m) => m.model === model || m.id === model)) return
    this.model = splitModelId(model)
    this.patch({ model })
  }

  setEffort(_effort: string) {}
  setServiceTier(_serviceTier: string | null) {}

  setCollaborationMode(name: string) {
    if (name.toLowerCase() === 'plan') return
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
    this.nav += 1
    const cwd = this.snapshot.folderDraft.trim() || homeDir()
    this.streamText.clear()
    this.patch({ cwd, showFolder: false, folderDraft: cwd, streaming: false })
    void this.restart()
  }

  private async restart() {
    await this.close()
    this.patch({ status: 'connecting' })
    await this.start()
    if (this.activeSessionId) void this.reconcile(this.activeSessionId)
    void this.refreshThreads()
  }

  async openThread(threadId: string) {
    this.patch({ openingThreadId: threadId, error: null })
    this.nav += 1
    const token = this.nav
    const client = this.client
    if (!client) {
      this.patch({ openingThreadId: null })
      return
    }
    this.abandonTurn()
    this.pendingLocalId = null
    try {
      const directory = this.snapshot.threads.find((thread) => thread.id === threadId)?.cwd
      const [messages, session] = await Promise.all([
        client.listMessages(threadId, 100, directory),
        client.getSession(threadId, directory),
      ])
      if (token !== this.nav) return
      this.activeSessionId = threadId
      this.streamText.clear()
      if (session?.model) this.model = { ...session.model }
      if (session?.agent && session.agent.toLowerCase() !== 'plan') this.agent = session.agent
      const keep = this.snapshot.blocks.filter(
        (b) => b.kind === 'approval' && (b.extra as { sessionId?: string } | undefined)?.sessionId === threadId,
      )
      this.patch({
        route: { kind: 'doc', threadId },
        title: sessionTitle(session?.title, messages),
        blocks: [...blocksFromMessages(messages), ...keep],
        cwd: session?.directory ?? this.snapshot.cwd,
        model: this.model ? `${this.model.providerID}/${this.model.modelID}` : this.snapshot.model,
        collaborationMode: this.agent,
        streaming: false,
        error: null,
        olderTurnsCursor: messages.length >= 100 ? '100' : null,
        loadingOlder: false,
        openingThreadId: null,
      })
      void this.refreshSkills()
    } catch (error) {
      if (token !== this.nav) return
      this.fail(error)
      this.patch({ openingThreadId: null, route: { kind: 'home' } })
    }
  }

  async loadOlderTurns() {
    const client = this.client
    const sessionId = this.activeSessionId
    const { olderTurnsCursor, loadingOlder, cwd } = this.snapshot
    if (!client || !sessionId || !olderTurnsCursor || loadingOlder || this.snapshot.streaming) return
    const token = this.nav
    const limit = Number(olderTurnsCursor) + 100
    this.patch({ loadingOlder: true })
    try {
      const messages = await client.listMessages(sessionId, limit, cwd)
      if (token !== this.nav) return
      const approvals = this.snapshot.blocks.filter((block) => block.kind === 'approval')
      this.patch({
        blocks: [...blocksFromMessages(messages), ...approvals],
        loadingOlder: false,
        olderTurnsCursor: messages.length >= limit ? String(limit) : null,
      })
    } catch (error) {
      if (token === this.nav) {
        this.fail(error)
        this.patch({ loadingOlder: false })
      }
    }
  }

  async createProject(name: string, cwd: string) {
    if (!this.client) throw new Error('Not connected')
    await this.client.createProject(name.trim(), cwd)
    await this.refreshCatalog()
  }

  async newDocument(options?: NewDocumentOptions) {
    this.nav += 1
    const token = this.nav
    const client = this.client
    if (!client) return
    this.abandonTurn()
    this.pendingLocalId = null
    try {
      const session = await client.createSession({
        agent: this.agent,
        model: this.model ?? undefined,
        directory: options?.cwd ?? (options ? homeDir() : this.snapshot.cwd),
        title: options?.title?.trim() || undefined,
      })
      if (token !== this.nav) return
      this.activeSessionId = session.id
      this.streamText.clear()
      this.patch({
        route: { kind: 'doc', threadId: session.id },
        title: options?.title?.trim() || 'Untitled document',
        blocks: [],
        cwd: session.directory || this.snapshot.cwd,
        streaming: false,
        error: null,
        olderTurnsCursor: null,
        loadingOlder: false,
      })
      void this.refreshSkills()
      await this.refreshThreads()
    } catch (error) {
      if (token !== this.nav) return
      this.fail(error)
      this.patch({ openingThreadId: null, route: { kind: 'home' } })
    }
  }

  async send(text: string, extras: SendExtras = {}) {
    const client = this.client
    const sessionId = this.activeSessionId
    if (!client || !sessionId || this.snapshot.streaming) return
    const trimmed = text.trim()
    const images = extras.images ?? []
    const skill = extras.skill ? this.skillBodies.get(extras.skill) : undefined
    if (!trimmed && images.length === 0 && !skill) return
    if (!this.model) {
      this.patch({ error: 'Pick a model first.' })
      return
    }
    const localId = `local-${Date.now()}`
    this.pendingLocalId = localId
    const echo: UserBlock = { kind: 'user', id: localId, text: trimmed }
    if (images.length) echo.images = images
    if (skill) echo.skills = [skill.name]
    this.patch({
      blocks: [...this.snapshot.blocks, echo],
      streaming: true,
      error: null,
    })
    try {
      const parts: OpenPromptPart[] = [
        ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
        ...(skill ? [skillPart(skill)] : []),
        ...images.map(imagePart),
      ]
      await client.promptAsync(sessionId, {
        model: { providerID: this.model.providerID, modelID: this.model.modelID },
        agent: this.agent,
        parts,
        directory: this.snapshot.cwd,
      })
    } catch (error) {
      this.pendingLocalId = null
      this.patch({
        blocks: this.snapshot.blocks.filter((block) => block.id !== localId),
        streaming: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Stops a turn left running in another session when navigating away. */
  private abandonTurn() {
    const client = this.client
    const sessionId = this.activeSessionId
    if (!client || !sessionId || !this.snapshot.streaming) return
    this.streamText.clear()
    this.patch({ streaming: false })
    void client.abort(sessionId, this.snapshot.cwd).catch(() => {})
  }

  async interrupt() {
    const client = this.client
    const sessionId = this.activeSessionId
    if (!client || !sessionId) return
    try {
      await client.abort(sessionId, this.snapshot.cwd)
    } catch {
      /* idle sessions may reject abort */
    }
    this.patch({ streaming: false })
    await this.reconcile(sessionId)
  }

  async setDocumentName(name: string) {
    const trimmed = name.trim()
    const sessionId = this.activeSessionId
    const client = this.client
    if (!client || !sessionId || !trimmed || trimmed === this.snapshot.title) return
    try {
      await client.renameSession(sessionId, trimmed, this.snapshot.cwd)
      if (this.activeSessionId !== sessionId) return
      this.patch({
        title: trimmed,
        threads: this.snapshot.threads.map((thread) =>
          thread.id === sessionId ? { ...thread, name: trimmed } : thread,
        ),
      })
    } catch (error) {
      this.fail(error)
    }
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
    this.patch({ blocks: approvals.setDraft(this.snapshot.blocks, blockId, key, value) })
  }

  resolveApproval(blockId: string, accept: boolean) {
    if (!this.client) return
    this.patch({
      blocks: approvals.resolveApproval(
        this.client,
        this.snapshot.blocks,
        blockId,
        accept,
        this.snapshot.cwd,
        (error) => this.fail(error),
      ),
    })
  }

  private async refreshThreads() {
    const client = this.client
    if (!client) return
    try {
      const search = this.snapshot.search
      const sessions = await client.listSessions({ search: search || undefined, limit: 100 })
      if (this.snapshot.search === search) this.patch({ threads: sessions.map(toCodexThread) })
    } catch {
      /* home list refresh is best-effort */
    }
  }

  private async reconcile(sessionId: string) {
    const client = this.client
    if (!client || this.activeSessionId !== sessionId) return
    try {
      const messages = await client.listMessages(
        sessionId,
        Math.max(100, Number(this.snapshot.olderTurnsCursor) || this.snapshot.blocks.length),
        this.snapshot.cwd,
      )
      if (this.activeSessionId !== sessionId) return
      const approvals = this.snapshot.blocks.filter((block) => block.kind === 'approval')
      this.pendingLocalId = null
      this.patch({ blocks: [...blocksFromMessages(messages), ...approvals], streaming: false })
    } catch {
      this.patch({ streaming: false })
    }
  }

  private onEvent(event: OpenEvent) {
    handleEvent(event, {
      getActiveId: () => this.activeSessionId,
      getBlocks: () => this.snapshot.blocks,
      patch: (partial) => this.patch(partial),
      streamText: this.streamText,
      reconcile: (id) => void this.reconcile(id),
      replaceLocalEcho: (id) => void this.replaceLocalEcho(id),
      refreshThreads: () => void this.refreshThreads(),
    })
  }

  private async replaceLocalEcho(serverId: string) {
    const pending = this.pendingLocalId
    if (!pending) return
    const client = this.client
    const sessionId = this.activeSessionId
    if (!client || !sessionId) return
    try {
      const messages = await client.listMessages(sessionId, 20, this.snapshot.cwd)
      const userMessages = messages.filter((message) => message.info.role === 'user')
      const latest = userMessages[userMessages.length - 1]
      if (!latest) return
      const block = this.snapshot.blocks.find((item) => item.id === pending)
      if (!block || block.kind !== 'user' || block.text !== messageText(latest, '\n')) return
      this.pendingLocalId = null
      this.patch({
        blocks: this.snapshot.blocks.map((item) => (item.id === pending ? { ...item, id: serverId } : item)),
      })
    } catch {
      /* echo reconciliation is best-effort; idle reconcile fixes stragglers */
    }
  }
}

const serviceTierReset = { serviceTier: null } as unknown as Partial<Snapshot>
