import type { AccountSummary, DocSummary, ProviderId, ToolServer } from './model'

export function accountLabel(account: AccountSummary | null): string {
  return account?.label || 'Sign in'
}

export function ownerLabel(account: AccountSummary | null): string {
  return account ? 'me' : '—'
}

export function threadTitle(thread: Pick<DocSummary, 'name' | 'preview'>): string {
  const name = thread.name?.trim()
  if (name) return name
  const firstLine = thread.preview?.trim().split('\n')[0]?.trim()
  return firstLine || 'Untitled document'
}

function sameDay(date: Date, now: Date): boolean {
  return (
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  )
}

/** Docs shows a time for today, month + day this year, and a full date otherwise. */
export function formatOpened(unixSeconds: number | null | undefined, now = new Date()): string {
  if (!unixSeconds) return ''
  const date = new Date(unixSeconds * 1000)
  if (sameDay(date, now)) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** List view shows a time for today and a full date otherwise, like Docs. */
export function formatListDate(unixSeconds: number | null | undefined, now = new Date()): string {
  if (!unixSeconds) return ''
  const date = new Date(unixSeconds * 1000)
  if (sameDay(date, now)) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function avatarLetter(account: AccountSummary | null): string {
  return account?.label ? account.label.charAt(0).toUpperCase() : '?'
}

export function toolsNeedingConnect(servers: ReadonlyArray<ToolServer>): ReadonlyArray<ToolServer> {
  return servers.filter((server) => server.needsConnect)
}

export function displayServerName(name: string): string {
  if (!name) return 'A connected app'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function previewLines(text: string, limit = 12): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  return trimmed.split(/\n+/).slice(0, limit).join('\n')
}

/**
 * Whether this build may carry the Claude library. Set at build time from
 * `HIDEGPT_PERSONAL` (see electron.vite.config.ts): runs from source keep it,
 * a shared `pnpm dist` build leaves it out unless `HIDEGPT_PERSONAL=1`.
 */
export const PERSONAL_BUILD: boolean = __HIDEGPT_PERSONAL__

/** The libraries a build can open, in switcher order. Claude only in a personal build. */
export function providersFor(personal: boolean): ReadonlyArray<ProviderId> {
  return personal ? ['codex', 'opencode', 'claude'] : ['codex', 'opencode']
}

/** Every library this build can open, in switcher order. */
export const PROVIDERS: ReadonlyArray<ProviderId> = providersFor(PERSONAL_BUILD)

export function providerLabel(provider: ProviderId): string {
  return provider === 'codex' ? 'Codex' : provider === 'opencode' ? 'OpenCode' : 'Claude'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
