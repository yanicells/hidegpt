import { displayServerName } from '../shared/labels'

/**
 * What a tool callout and a tool's approval card say, by the kind of step it
 * was. Adapters map their own tool names to a kind (Claude in
 * `claude/mapping.ts`, OpenCode in `opencode/mapping.ts`), so the page never
 * shows a raw tool name. Wording is the "Tool rows" and "Requests and
 * questions" tables of the stealth audit (STL-2).
 */
export type ToolKind =
  | 'command'
  | 'file_read'
  | 'file_change'
  | 'file_search'
  | 'web_search'
  | 'web_fetch'
  | 'subagent'
  | 'mcp_tool'
  | 'other'

type NamedKind = Exclude<ToolKind, 'mcp_tool'>

const TITLES: Record<NamedKind, { readonly running: string; readonly done: string }> = {
  command: { running: 'Running a command', done: 'Ran a command' },
  file_read: { running: 'Opening a file', done: 'Opened a file' },
  file_change: { running: 'Editing a file', done: 'Edited a file' },
  file_search: { running: 'Searching files', done: 'Searched files' },
  web_search: { running: 'Looking something up', done: 'Looked something up' },
  web_fetch: { running: 'Opening a link', done: 'Opened a link' },
  subagent: { running: 'Background task', done: 'Background task' },
  other: { running: 'Doing a step', done: 'Did a step' },
}

const REQUEST_TITLES: Record<NamedKind, string> = {
  command: 'Run this command?',
  file_read: 'Open this file?',
  file_change: 'Edit this file?',
  file_search: 'Open this file?',
  web_search: 'Look this up online?',
  web_fetch: 'Look this up online?',
  subagent: 'Allow this step?',
  other: 'Allow this step?',
}

// The stealth list, plus the words banned from visible prose. Lowercase.
const BANNED_WORDS = [
  'ai',
  'assistant',
  'agent',
  'model',
  'prompt',
  'llm',
  'token',
  'claude',
  'codex',
  'opencode',
  'chatgpt',
  'anthropic',
  'openai',
  'gpt',
  'copilot',
  'bot',
  'hidegpt',
  'mcp',
  'sdk',
  'cli',
  'subagent',
  'provider',
]

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
    for (const word of BANNED_WORDS) {
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

/**
 * "{app} · {tool}" for a connected-app tool. A server named after the vendor
 * (`claude_ai_Notion`) reads as "Notion"; one with nothing left reads "A connected app".
 */
function connectedAppTitle(name: string): string {
  const { app, tool } = appAndTool(name)
  return tool ? `${displayServerName(app)} · ${tool}` : displayServerName(app)
}

/** The callout title for a step: running or done, by kind. A connected-app tool needs its raw `name`. */
export function toolTitle(kind: ToolKind, done: boolean, name = ''): string {
  if (kind === 'mcp_tool') return connectedAppTitle(name)
  const titles = TITLES[kind]
  return done ? titles.done : titles.running
}

/**
 * The approval card's question for a tool, by kind. A connected app is named only
 * when something neutral is left of its server name ("Use Notion?").
 */
export function requestTitle(kind: ToolKind, name = ''): string {
  if (kind !== 'mcp_tool') return REQUEST_TITLES[kind]
  const { app } = appAndTool(name)
  return app ? `Use ${displayServerName(app)}?` : REQUEST_TITLES.other
}

const DONE_BY_RUNNING = new Map(Object.values(TITLES).map((titles) => [titles.running, titles.done]))

/** The finished form of a running title; titles with one form come back unchanged. */
export const finishedTitle = (title: string): string => DONE_BY_RUNNING.get(title) ?? title
