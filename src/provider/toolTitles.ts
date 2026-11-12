import { connectedAppTitle, toolRequestTitle, toolTitle as kindTitle } from '../main/session/present'
import { isStealthy } from '../shared/stealth'
import type { ToolKind, ToolStatus } from './events'

/**
 * Tool titles for adapters that still title their own rows and cards (the legacy
 * contract). The wording is `present.ts`'s; this file only keeps a raw tool name
 * off the page: a connected app's server and tool names lose every banned part
 * before `present.ts` puts them in a sentence.
 */

/**
 * A server or tool name without its banned parts, or '' when nothing is left. A part
 * (split at spaces, `_`, `.`, `:` and `-`) that carries a banned word anywhere is
 * dropped whole, so "GPT4o" leaves no "4o" behind.
 */
const neutralPart = (name: string) =>
  name
    .split(/[\s_.:-]+/)
    .filter((part) => part && isStealthy(part))
    .join(' ')

/**
 * The app and tool of a connected-app tool name: Claude's `mcp__server__tool`, or
 * OpenCode's `server_tool`.
 */
function appAndTool(name: string): { readonly app: string; readonly tool: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^([^_]+)_(.+)$/.exec(name)
  return { app: neutralPart(match?.[1] ?? ''), tool: neutralPart(match?.[2] ?? '') }
}

/** A tool row's title by kind and status. A running or finished connected-app tool needs its raw `name`. */
export function toolTitle(kind: ToolKind, status: ToolStatus, name = ''): string {
  // A failed connected-app call reads like any failed step: Docs' sentence, no names.
  if (kind !== 'mcp_tool' || status === 'failed') return kindTitle(kind, status)
  const { app, tool } = appAndTool(name)
  return connectedAppTitle(app, tool)
}

/**
 * The approval card's question for a tool, by kind. A connected app is named only
 * when something neutral is left of its server name ("Use Notion?").
 */
export const requestTitle = (kind: ToolKind, name = ''): string =>
  toolRequestTitle(kind, kind === 'mcp_tool' ? appAndTool(name).app : '')
