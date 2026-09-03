import type { CommandExecutionRequestApprovalParams } from '../generated/codex/v2/CommandExecutionRequestApprovalParams'
import type { FileChangeRequestApprovalParams } from '../generated/codex/v2/FileChangeRequestApprovalParams'
import type { McpServerElicitationRequestParams } from '../generated/codex/v2/McpServerElicitationRequestParams'
import type { PermissionsRequestApprovalParams } from '../generated/codex/v2/PermissionsRequestApprovalParams'
import type { ToolRequestUserInputParams } from '../generated/codex/v2/ToolRequestUserInputParams'

import type { PendingApproval } from './blocks'
import type { JsonRpcId } from './jsonrpc'
import { elicitationProperties } from './labels'
import type { SessionCtx } from './types'

type ApprovalRequest = { id: JsonRpcId; method: string; params: unknown }

type ApprovalSpec<Params> = {
  title: string | ((params: Params) => string)
  bodyOf: (params: Params) => string
  resultOf: (block: PendingApproval, accept: boolean) => unknown
  draftsOf?: (params: Params) => Record<string, string>
  keepParams?: boolean
}

function commandBody(
  params: CommandExecutionRequestApprovalParams & { command?: string | string[]; reason?: string | null },
): string {
  const command = Array.isArray(params.command) ? params.command.join(' ') : params.command
  return command ?? params.reason ?? 'Command'
}

function elicitationDrafts(params: McpServerElicitationRequestParams): Record<string, string> {
  const drafts: Record<string, string> = {}
  const properties = elicitationProperties(params)
  for (const [key, schema] of Object.entries(properties)) {
    if (schema && typeof schema === 'object' && 'default' in schema && schema.default != null) {
      drafts[key] = String(schema.default)
    }
  }
  return drafts
}

const commandSpec: ApprovalSpec<
  CommandExecutionRequestApprovalParams & { command?: string | string[]; reason?: string | null }
> = {
  title: 'Run command?',
  bodyOf: commandBody,
  resultOf: (_block, accept) => ({ decision: accept ? 'accept' : 'decline' }),
}

const patchSpec: ApprovalSpec<FileChangeRequestApprovalParams> = {
  title: 'Apply file changes?',
  bodyOf: (params) => params.reason ?? 'The assistant wants to edit files.',
  resultOf: (_block, accept) => ({ decision: accept ? 'accept' : 'decline' }),
}

const APPROVALS: Record<string, ApprovalSpec<any>> = {
  execCommandApproval: {
    ...commandSpec,
    resultOf: (_block, accept) =>
      accept ? { decision: 'approved' } : { decision: { denied: { rejection: 'skipped' } } },
  },
  'item/commandExecution/requestApproval': commandSpec,
  applyPatchApproval: {
    ...patchSpec,
    resultOf: (_block, accept) =>
      accept ? { decision: 'approved' } : { decision: { denied: { rejection: 'skipped' } } },
  },
  'item/fileChange/requestApproval': patchSpec,
  'item/permissions/requestApproval': {
    title: 'Grant extra access?',
    bodyOf: (params: PermissionsRequestApprovalParams) =>
      params.reason ?? 'The assistant needs more permissions.',
    resultOf: (block, accept) => {
      const params = block.extra as PermissionsRequestApprovalParams
      if (!accept) return { permissions: {}, scope: 'turn' }
      return {
        permissions: {
          network: params.permissions.network ?? undefined,
          fileSystem: params.permissions.fileSystem ?? undefined,
        },
        scope: 'turn',
      }
    },
    keepParams: true,
  },
  'mcpServer/elicitation/request': {
    title: (params: McpServerElicitationRequestParams) => `Continue with ${params.serverName}?`,
    bodyOf: (params: McpServerElicitationRequestParams) => params.message,
    resultOf: (block, accept) => {
      const params = block.extra as McpServerElicitationRequestParams
      if (!accept) return { action: 'cancel', content: null, _meta: null }
      const content =
        params.mode === 'form' || params.mode === 'openai/form' ? { ...block.drafts } : null
      return { action: 'accept', content, _meta: null }
    },
    draftsOf: elicitationDrafts,
    keepParams: true,
  },
  'item/tool/requestUserInput': {
    title: 'The assistant needs input',
    bodyOf: (params: ToolRequestUserInputParams) =>
      params.questions.map((question) => question.question).filter(Boolean).join('\n') || 'Continue?',
    resultOf: (block, accept) => {
      const params = block.extra as ToolRequestUserInputParams
      const answers: Record<string, { answers: string[] }> = {}
      if (accept) {
        for (const question of params.questions) {
          const value = block.drafts[question.id] ?? ''
          answers[question.id] = { answers: value ? [value] : [] }
        }
      }
      return { answers }
    },
    keepParams: true,
  },
}

export function approvalFromRequest(request: ApprovalRequest): PendingApproval | null {
  const spec = APPROVALS[request.method]
  if (!spec) return null
  const params = request.params
  return {
    kind: 'approval',
    id: `approval-${String(request.id)}`,
    requestId: request.id,
    method: request.method,
    title: typeof spec.title === 'function' ? spec.title(params) : spec.title,
    body: spec.bodyOf(params),
    resolved: null,
    ...(spec.keepParams ? { extra: params } : {}),
    drafts: spec.draftsOf ? spec.draftsOf(params) : {},
  }
}

export function approvalResult(block: PendingApproval, accept: boolean): unknown {
  const spec = APPROVALS[block.method]
  if (!spec) return {}
  return spec.resultOf(block, accept)
}

export function setApprovalDraft(ctx: SessionCtx, blockId: string, key: string, value: string) {
  ctx.patch({
    blocks: ctx
      .getSnapshot()
      .blocks.map((item) =>
        item.kind === 'approval' && item.id === blockId
          ? { ...item, drafts: { ...item.drafts, [key]: value } }
          : item,
      ),
  })
}

export function resolveApproval(ctx: SessionCtx, blockId: string, accept: boolean) {
  const snapshot = ctx.getSnapshot()
  const block = snapshot.blocks.find((item) => item.id === blockId)
  if (!block || block.kind !== 'approval' || block.resolved !== null) return
  ctx.respond(block.requestId, approvalResult(block, accept))
  ctx.patch({
    blocks: snapshot.blocks.map((item) =>
      item.id === blockId ? { ...item, resolved: accept ? 'accepted' : 'skipped' } : item,
    ),
  })
  if (block.method === 'mcpServer/elicitation/request') {
    const params = block.extra as McpServerElicitationRequestParams | undefined
    if (params?.threadId) {
      decrementElicitation(ctx, params.threadId)
    }
  }
}

export function incrementElicitation(ctx: SessionCtx, threadId: string) {
  void ctx.rpc('thread/increment_elicitation', { threadId }).catch(() => {})
}

export function decrementElicitation(ctx: SessionCtx, threadId: string) {
  void ctx.rpc('thread/decrement_elicitation', { threadId }).catch(() => {})
}
