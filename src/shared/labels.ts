import type { AccountSummary, DocSummary, ProviderId, ToolServer } from './model'
import { isStealthy, neutralizeName, neutralizeSentence } from './stealth'

/** The account's address, when the provider gave one. */
export function accountAddress(account: AccountSummary | null): string | null {
  const label = account?.label.trim() ?? ''
  return label.includes('@') ? label : null
}

/**
 * What the page calls the signed-in account: its address, as Google shows it.
 * Providers without one label the account with their own name ("ChatGPT",
 * "Claude Code"), which must never reach the screen, so those read as a plain
 * Google Account.
 */
export function accountLabel(account: AccountSummary | null): string {
  if (!account) return 'Sign in'
  return accountAddress(account) ?? 'Google Account'
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

/** List view shows a time for today and a full date otherwise, like Docs. */
export function formatListDate(unixSeconds: number | null | undefined, now = new Date()): string {
  if (!unixSeconds) return ''
  const date = new Date(unixSeconds * 1000)
  if (sameDay(date, now)) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function avatarLetter(account: AccountSummary | null): string {
  return account ? accountLabel(account).charAt(0).toUpperCase() : '?'
}

export function toolsNeedingConnect(servers: ReadonlyArray<ToolServer>): ReadonlyArray<ToolServer> {
  return servers.filter((server) => server.needsConnect)
}

/** A connected app (MCP server) as the page names it: `claude-in-chrome` reads "In Chrome". */
export function displayServerName(name: string): string {
  return neutralizeName(name, 'A connected app')
}

/** A skill's name in the "@" menu and on its chip: `codex:rescue` reads "Rescue". */
export function skillLabel(name: string): string {
  return neutralizeName(name, 'Smart chip')
}

/**
 * A skill's description under its name in the "@" menu, or null to leave it
 * out: one that still reads as tooling once vendor names are gone ("Ask the
 * agent…", "Uses MCP tools") has no Docs wording to fall back to.
 */
export function skillDescription(description: string): string | null {
  const text = neutralizeSentence(description)
  return text && isStealthy(text) ? text : null
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

/**
 * Each library as one of the person's Google accounts, the way Chrome names
 * profiles. This is the only name a library has on screen.
 */
export function libraryName(provider: ProviderId): string {
  return provider === 'codex' ? 'Personal' : provider === 'opencode' ? 'Work' : 'School'
}

/** The provider's real name, for logs and error details only (behind "Details"). */
export function providerLabel(provider: ProviderId): string {
  return provider === 'codex' ? 'Codex' : provider === 'opencode' ? 'OpenCode' : 'Claude'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
