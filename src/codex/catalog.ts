import { randomUUID } from 'node:crypto'
import type { ProjectCreateParams } from '../generated/codex/v2/ProjectCreateParams'
import type { CollaborationModeMask } from '../generated/codex/v2/CollaborationModeMask'
import type { GetAccountRateLimitsResponse } from '../generated/codex/v2/GetAccountRateLimitsResponse'
import type { GetAccountResponse } from '../generated/codex/v2/GetAccountResponse'
import type { ListMcpServerStatusResponse } from '../generated/codex/v2/ListMcpServerStatusResponse'
import type { ModelListResponse } from '../generated/codex/v2/ModelListResponse'
import type { Project } from '../generated/codex/v2/Project'
import type { ProjectListResponse } from '../generated/codex/v2/ProjectListResponse'
import type { Thread } from '../generated/codex/v2/Thread'
import type { ThreadListResponse } from '../generated/codex/v2/ThreadListResponse'
import type { ThreadSourceKind } from '../generated/codex/v2/ThreadSourceKind'
import type { Turn } from '../generated/codex/v2/Turn'
import type { TurnsPage } from '../generated/codex/v2/TurnsPage'

import { blocksFromTurns, mergeOlderBlocks } from './blocks'
import type { SessionCtx } from './types'

const INTERACTIVE_SOURCES: ThreadSourceKind[] = ['cli', 'vscode', 'appServer']

export const defaultCwd = () => `${process.env.HOME ?? process.env.USERPROFILE ?? ''}/.codex/threads`

export async function refreshCatalog(ctx: SessionCtx) {
  const threadId = ctx.getActiveId()
  const search = ctx.getSnapshot().search
  const [account, models, threads, projects, modes, rateLimits, mcp] = await Promise.all([
    ctx.rpc<GetAccountResponse>('account/read', { refreshToken: false }),
    ctx.rpc<ModelListResponse>('model/list', {}),
    listAllThreads(ctx),
    listProjects(ctx).catch(() => ctx.getSnapshot().projects),
    ctx.rpc<{ data: CollaborationModeMask[] }>('collaborationMode/list', {}).catch(() => ({ data: [] })),
    ctx.rpc<GetAccountRateLimitsResponse>('account/rateLimits/read', {}).catch(() => null),
    ctx
      .rpc<ListMcpServerStatusResponse>('mcpServerStatus/list', {
        detail: 'toolsAndAuthOnly',
        ...(threadId ? { threadId } : {}),
      })
      .catch(() => ({ data: [] })),
  ])
  const collaborationModes = modes.data.filter((mode) => mode.mode !== 'plan' && mode.name.toLowerCase() !== 'plan')
  const mcpServers = mcp.data
  const visibleModels = models.data.filter((model) => !model.hidden)
  const selected = visibleModels.find((model) => model.isDefault) ?? visibleModels[0] ?? models.data[0]
  const snapshot = ctx.getSnapshot()
  ctx.patch({
    account: account.account,
    requiresAuth: account.account == null,
    models: visibleModels.length > 0 ? visibleModels : models.data,
    model: snapshot.model ?? selected?.model ?? null,
    effort: snapshot.effort ?? selected?.defaultReasoningEffort ?? null,
    collaborationModes,
    collaborationMode: snapshot.collaborationMode ?? collaborationModes[0]?.name ?? null,
    projects,
    ...(ctx.getSnapshot().search === search ? { threads } : {}),
    rateLimits,
    mcpServers,
  })
}

export async function listAllThreads(ctx: SessionCtx): Promise<Thread[]> {
  const all: Thread[] = []
  let nextCursor: string | null = null
  const search = ctx.getSnapshot().search.trim()
  for (let page = 0; page < 20; page += 1) {
    const listed: ThreadListResponse = await ctx.rpc('thread/list', {
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

export async function listTurns(ctx: SessionCtx, threadId: string): Promise<{ turns: Turn[]; cursor: string | null }> {
  try {
    const page = await ctx.rpc<TurnsPage>('thread/turns/list', {
      threadId,
      limit: 30,
      sortDirection: 'desc',
      itemsView: 'full',
    })
    return { turns: [...page.data].reverse(), cursor: page.backwardsCursor }
  } catch {
    return { turns: [], cursor: null }
  }
}

export async function loadOlderTurns(ctx: SessionCtx, token: number) {
  const threadId = ctx.getActiveId()
  const snapshot = ctx.getSnapshot()
  const cursor = snapshot.olderTurnsCursor
  if (!threadId || !cursor || snapshot.loadingOlder) return
  ctx.patch({ loadingOlder: true })
  try {
    const page = await ctx.rpc<TurnsPage>('thread/turns/list', {
      threadId,
      cursor,
      limit: 30,
      sortDirection: 'desc',
      itemsView: 'full',
    })
    if (!ctx.guard(token) || ctx.getActiveId() !== threadId) {
      ctx.patch({ loadingOlder: false })
      return
    }
    ctx.patch({
      blocks: mergeOlderBlocks(blocksFromTurns([...page.data].reverse()), ctx.getSnapshot().blocks),
      olderTurnsCursor: page.backwardsCursor,
      loadingOlder: false,
    })
  } catch (error) {
    if (!ctx.guard(token)) {
      ctx.patch({ loadingOlder: false })
      return
    }
    ctx.patch({
      loadingOlder: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function setSearch(ctx: SessionCtx, value: string) {
  ctx.patch({ search: value })
}

export async function applySearch(ctx: SessionCtx) {
  await refreshThreads(ctx)
}

export function toggleFolder(ctx: SessionCtx, show: boolean) {
  ctx.patch({ showFolder: show, folderDraft: ctx.getSnapshot().cwd })
}

export function setFolderDraft(ctx: SessionCtx, value: string) {
  ctx.patch({ folderDraft: value })
}

export function applyFolder(ctx: SessionCtx) {
  const snapshot = ctx.getSnapshot()
  const cwd = snapshot.folderDraft.trim() || defaultCwd()
  ctx.patch({ cwd, showFolder: false, folderDraft: cwd })
}

export async function setDocumentName(ctx: SessionCtx, name: string) {
  const threadId = ctx.getActiveId()
  const snapshot = ctx.getSnapshot()
  const trimmed = name.trim()
  if (!threadId || !trimmed || trimmed === snapshot.title) return
  try {
    await ctx.rpc('thread/name/set', { threadId, name: trimmed })
    ctx.patch({
      title: trimmed,
      threads: ctx
        .getSnapshot()
        .threads.map((thread) => (thread.id === threadId ? { ...thread, name: trimmed } : thread)),
    })
  } catch (error) {
    ctx.patch({ error: error instanceof Error ? error.message : String(error) })
  }
}

export async function createProject(ctx: SessionCtx, name: string, cwd: string) {
  const params: ProjectCreateParams = { name: name.trim(), roots: [{ path: cwd }], idempotencyKey: randomUUID() }
  await ctx.rpc('project/create', params)
  await refreshCatalog(ctx)
}

async function listProjects(ctx: SessionCtx): Promise<Project[]> {
  const projects: Project[] = []
  let cursor: string | null = null
  do {
    const listed: ProjectListResponse = await ctx.rpc('project/list', { limit: 100, cursor, sortKey: 'recencyAt' })
    projects.push(...listed.data)
    cursor = listed.nextCursor
  } while (cursor)
  return projects
}

export async function refreshThreads(ctx: SessionCtx) {
  const search = ctx.getSnapshot().search
  const threads = await listAllThreads(ctx)
  if (ctx.getSnapshot().search === search) ctx.patch({ threads })
}
