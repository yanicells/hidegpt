import { readFileSync } from 'node:fs'

import type { AccountRateLimitsUpdatedNotification } from '../generated/codex/v2/AccountRateLimitsUpdatedNotification'
import type { ChatgptAuthTokensRefreshResponse } from '../generated/codex/v2/ChatgptAuthTokensRefreshResponse'
import type { ErrorNotification } from '../generated/codex/v2/ErrorNotification'
import type { McpServerElicitationRequestParams } from '../generated/codex/v2/McpServerElicitationRequestParams'
import type { ServerRequestResolvedNotification } from '../generated/codex/v2/ServerRequestResolvedNotification'
import type { ThreadItem } from '../generated/codex/v2/ThreadItem'
import type { TurnCompletedNotification } from '../generated/codex/v2/TurnCompletedNotification'
import type { WarningNotification } from '../generated/codex/v2/WarningNotification'

import * as approvals from './approvals'
import { upsertAgentDelta, upsertCalloutDelta, upsertCalloutReplace, upsertItem } from './blocks'
import * as catalog from './catalog'
import type { JsonRpcId } from './jsonrpc'
import type { SessionCtx } from './types'

export async function onNotification(ctx: SessionCtx, method: string, params: unknown) {
  const snapshot = ctx.getSnapshot()
  const threadId = (params as { threadId?: string } | null)?.threadId
  if (threadId && (!ctx.getActiveId() || threadId !== ctx.getActiveId())) {
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
    ctx.patch({
      blocks: upsertAgentDelta(snapshot.blocks, delta.itemId, delta.delta),
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
    ctx.patch({
      blocks: upsertCalloutDelta(snapshot.blocks, delta.itemId, 'Running a command', delta.delta),
    })
    return
  }
  if (method === 'turn/diff/updated') {
    const diff = params as { turnId: string; diff: string }
    ctx.patch({
      blocks: upsertCalloutReplace(snapshot.blocks, `diff-${diff.turnId}`, 'Changes', diff.diff),
    })
    return
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = (params as { item: ThreadItem }).item
    ctx.patch({ blocks: upsertItem(snapshot.blocks, item) })
    return
  }
  if (method === 'turn/completed') {
    const completed = params as TurnCompletedNotification
    ctx.patch({
      streaming: false,
      error:
        completed.turn.status === 'failed' && completed.turn.error
          ? completed.turn.error.message
          : null,
    })
    return
  }
  if (method === 'error') {
    const failed = params as ErrorNotification
    ctx.patch({
      streaming: failed.willRetry ? snapshot.streaming : false,
      error: failed.error.message,
    })
    return
  }
  if (method === 'warning' || method === 'guardianWarning') {
    const warning = params as WarningNotification
    ctx.patch({ error: warning.message })
    return
  }
  if (method === 'configWarning') {
    const warning = params as { summary?: string }
    if (warning.summary) ctx.patch({ error: warning.summary })
    return
  }
  if (method === 'account/rateLimits/updated') {
    const update = params as AccountRateLimitsUpdatedNotification
    ctx.patch({
      rateLimits: snapshot.rateLimits
        ? { ...snapshot.rateLimits, rateLimits: update.rateLimits }
        : { rateLimits: update.rateLimits, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null },
    })
    return
  }
  if (method === 'serverRequest/resolved') {
    const resolved = params as ServerRequestResolvedNotification
    ctx.patch({
      blocks: snapshot.blocks.map((block) =>
        block.kind === 'approval' && String(block.requestId) === String(resolved.requestId)
          ? { ...block, resolved: block.resolved ?? 'skipped' }
          : block,
      ),
    })
    return
  }
  if (method === 'thread/name/updated') {
    const name = (params as { threadName?: string }).threadName
    if (name) ctx.patch({ title: name })
    return
  }
  if (method === 'thread/closed' || method === 'thread/deleted' || method === 'thread/archived') {
    const closedId = (params as { threadId?: string }).threadId
    if (closedId && closedId === ctx.getActiveId()) {
      ctx.setActiveId(null)
      ctx.patch({
        route: { kind: 'home' },
        title: 'Docs',
        blocks: [],
        streaming: false,
        olderTurnsCursor: null,
        error: 'This document is no longer available.',
      })
    }
    await catalog.refreshCatalog(ctx).catch(() => {})
    return
  }
  if (method === 'account/updated' || method === 'account/login/completed') {
    ctx.patch({ loginUrl: null })
    await catalog.refreshCatalog(ctx).catch(() => {})
    return
  }
  if (method === 'project/changed' || method === 'mcpServer/oauthLogin/completed') {
    if (method === 'mcpServer/oauthLogin/completed') ctx.patch({ loginUrl: null })
    await catalog.refreshCatalog(ctx).catch(() => {})
  }
}

export function onServerRequest(
  ctx: SessionCtx,
  request: { id: JsonRpcId; method: string; params: unknown },
) {
  if (request.method === 'currentTime/read') {
    ctx.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) })
    return
  }
  if (request.method === 'account/chatgptAuthTokens/refresh') {
    void refreshChatgptTokens(ctx, request.id)
    return
  }
  if (request.method === 'item/tool/call') {
    ctx.respond(request.id, {
      contentItems: [{ type: 'inputText', text: 'This Docs window does not host that tool.' }],
      success: false,
    })
    return
  }
  if (request.method === 'attestation/generate') {
    ctx.reject(request.id, 'attestation is not enabled')
    return
  }
  const approval = approvals.approvalFromRequest(request)
  if (approval) {
    const paramsThreadId = (request.params as { threadId?: unknown } | null)?.threadId
    const activeId = ctx.getActiveId()
    if (typeof paramsThreadId === 'string' && activeId && paramsThreadId !== activeId) {
      ctx.reject(request.id, 'thread not active')
      return
    }
    const snapshot = ctx.getSnapshot()
    ctx.patch({ blocks: [...snapshot.blocks, approval] })
    if (request.method === 'mcpServer/elicitation/request') {
      const params = request.params as McpServerElicitationRequestParams
      approvals.incrementElicitation(ctx, params.threadId)
      if (params.mode === 'url') {
        ctx.patch({ loginUrl: params.url })
        ctx.openUrl(params.url)
      }
    }
    return
  }
  ctx.reject(request.id, `unhandled ${request.method}`)
}

export async function refreshChatgptTokens(ctx: SessionCtx, id: JsonRpcId) {
  try {
    await ctx.rpc('account/read', { refreshToken: true })
  } catch {
    // file on disk may still be valid
  }
  const tokens = readCodexAuthTokens()
  if (tokens) {
    ctx.respond(id, tokens)
    return
  }
  ctx.reject(id, 'Codex-managed ChatGPT auth has no refreshable tokens')
  ctx.patch({ requiresAuth: true, error: 'Sign in with ChatGPT to refresh this session.' })
}

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
