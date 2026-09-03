import type { Account } from '../generated/codex/v2/Account'
import type { McpServerElicitationRequestParams } from '../generated/codex/v2/McpServerElicitationRequestParams'
import type { McpServerStatus } from '../generated/codex/v2/McpServerStatus'
import type { Thread } from '../generated/codex/v2/Thread'
import type { ToolRequestUserInputParams } from '../generated/codex/v2/ToolRequestUserInputParams'

import type { PendingApproval } from './blocks'

export function formatCodexError(message: string): string {
  if (/active writer|thread-store conflict/i.test(message)) {
    return 'This document is open in ChatGPT or another window. Close it there, then open it here.'
  }
  return message
}

export function accountLabel(account: Account | null): string {
  if (!account) return 'Sign in'
  if (account.type === 'chatgpt') return account.email ?? 'ChatGPT'
  if (account.type === 'apiKey') return 'API key'
  return 'Account'
}

export function ownerLabel(account: Account | null): string {
  return account ? 'me' : '—'
}

export function threadTitle(thread: Pick<Thread, 'name' | 'preview'>): string {
  const name = thread.name?.trim()
  if (name) return name
  const firstLine = thread.preview?.trim().split('\n')[0]?.trim()
  return firstLine || 'Untitled document'
}

/** Docs shows a time for today, month + day this year, and a full date otherwise. */
export function formatOpened(unixSeconds: number | null | undefined, now = new Date()): string {
  if (!unixSeconds) return ''
  const date = new Date(unixSeconds * 1000)
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function avatarLetter(account: Account | null): string {
  const label = accountLabel(account)
  if (label === 'Sign in') return '?'
  return label.charAt(0).toUpperCase()
}

export function needsReconnect(server: McpServerStatus): boolean {
  return (
    server.authStatus === 'notLoggedIn' ||
    server.runtimeStatus === 'authenticationRequired' ||
    server.runtimeStatus === 'failed'
  )
}

export function toolsNeedingConnect(servers: McpServerStatus[]): McpServerStatus[] {
  return servers.filter(needsReconnect)
}

export function displayServerName(name: string): string {
  if (!name) return 'A connected app'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function formFields(block: PendingApproval): { key: string; label: string }[] {
  if (block.method !== 'mcpServer/elicitation/request') return []
  const params = block.extra as McpServerElicitationRequestParams | undefined
  if (!params) return []
  return Object.entries(elicitationProperties(params)).map(([key, schema]) => ({
    key,
    label: (schema && typeof schema === 'object' && 'title' in schema && schema.title) || key,
  }))
}

export function inputQuestions(block: PendingApproval): ToolRequestUserInputParams['questions'] {
  if (block.method !== 'item/tool/requestUserInput') return []
  return (block.extra as ToolRequestUserInputParams | undefined)?.questions ?? []
}

export function elicitationProperties(
  params: McpServerElicitationRequestParams,
): Record<string, { title?: string; default?: unknown } | undefined> {
  if (params.mode === 'form') return params.requestedSchema.properties ?? {}
  if (params.mode === 'openai/form') {
    const schema = params.requestedSchema as {
      properties?: Record<string, { title?: string; default?: unknown }>
    }
    return schema.properties ?? {}
  }
  return {}
}

export function previewLines(text: string, limit = 12): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  return trimmed.split(/\n+/).slice(0, limit).join('\n')
}
