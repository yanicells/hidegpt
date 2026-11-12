import { connectedAppTitle, toolRequestTitle, toolTitle as kindTitle } from '../main/session/present'
import { BANNED_WORDS } from '../shared/stealth'
import type { ToolKind, ToolStatus } from './events'

/**
 * Tool titles for adapters that still title their own rows and cards (the legacy
 * contract). The wording is `present.ts`'s; this file only keeps a raw tool name
 * off the page: a connected app's server and tool names lose every banned part
 * before `present.ts` puts them in a sentence.
 */

// The stealth list, plus the words banned from visible prose.
const BANNED = [...BANNED_WORDS, 'hidegpt', 'mcp', 'sdk', 'cli', 'subagent', 'provider']

const isLetter = (char: string | undefined) => char !== undefined && /\p{L}/u.test(char)
const isUpper = (char: string | undefined) => char !== undefined && /\p{Lu}/u.test(char)
const isLower = (char: string | undefined) => char !== undefined && /\p{Ll}/u.test(char)

// A word can start after a non-letter, at a lower-to-upper step ("myGpt"), or inside
// a capital run ("ChatGPTPlus"), and end before a non-letter or digit ("gpt5"), at a
// lower-to-upper step, or after a capital ("AIsearch", "GPT4o").
const startsWord = (text: string, at: number) =>
  !isLetter(text[at - 1]) ||
  (isLower(text[at - 1]) && isUpper(text[at])) ||
  (isUpper(text[at - 1]) && isUpper(text[at]))
const endsWord = (text: string, at: number) =>
  !isLetter(text[at]) || isUpper(text[at - 1]) || (isLower(text[at - 1]) && isUpper(text[at]))

/** Whether a name part carries a banned word at a word, case or digit boundary (plurals too). */
function mentionsBanned(part: string): boolean {
  const lower = part.toLowerCase()
  for (let at = 0; at < part.length; at++) {
    if (!startsWord(part, at)) continue
    for (const word of BANNED) {
      if (!lower.startsWith(word, at)) continue
      const end = at + word.length
      if (endsWord(part, end) || (lower[end] === 's' && endsWord(part, end + 1))) return true
    }
  }
  return false
}

/**
 * A server or tool name without its banned parts, or '' when nothing is left. A part
 * (split at spaces, `_`, `.`, `:` and `-`) that carries a banned word anywhere is
 * dropped whole, so "GPT4o" leaves no "4o" behind.
 */
const neutralPart = (name: string) =>
  name
    .split(/[\s_.:-]+/)
    .filter((part) => part && !mentionsBanned(part))
    .join(' ')

/**
 * The app and tool of a connected-app tool name: Claude's `mcp__server__tool`, or
 * OpenCode's `server_tool`.
 */
function appAndTool(name: string): { readonly app: string; readonly tool: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^([^_]+)_(.+)$/.exec(name)
  return { app: neutralPart(match?.[1] ?? ''), tool: neutralPart(match?.[2] ?? '') }
}

/** A tool row's title by kind and status. A connected-app tool needs its raw `name`. */
export function toolTitle(kind: ToolKind, status: ToolStatus, name = ''): string {
  if (kind !== 'mcp_tool') return kindTitle(kind, status)
  const { app, tool } = appAndTool(name)
  return connectedAppTitle(app, tool)
}

/**
 * The approval card's question for a tool, by kind. A connected app is named only
 * when something neutral is left of its server name ("Use Notion?").
 */
export const requestTitle = (kind: ToolKind, name = ''): string =>
  toolRequestTitle(kind, kind === 'mcp_tool' ? appAndTool(name).app : '')
