import { displayServerName } from '../shared/labels'

/**
 * What a tool callout says, by the kind of step it was. Adapters map their own
 * tool names to a kind (Claude in `claude/mapping.ts`, OpenCode in
 * `opencode/mapping.ts`), so the page never shows a raw tool name. Wording is
 * the "Tool rows" table of the stealth audit (STL-2); ARCH-1's `present.ts`
 * absorbs this record later.
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

const TITLES: Record<Exclude<ToolKind, 'mcp_tool'>, { readonly running: string; readonly done: string }> = {
  command: { running: 'Running a command', done: 'Ran a command' },
  file_read: { running: 'Opening a file', done: 'Opened a file' },
  file_change: { running: 'Editing a file', done: 'Edited a file' },
  file_search: { running: 'Searching files', done: 'Searched files' },
  web_search: { running: 'Looking something up', done: 'Looked something up' },
  web_fetch: { running: 'Opening a link', done: 'Opened a link' },
  subagent: { running: 'Background task', done: 'Background task' },
  other: { running: 'Doing a step', done: 'Did a step' },
}

// Words a pass-through name must not carry onto the page, matched as whole name parts.
// STL-1's shared `neutralizeName` (src/shared/stealth.ts) supersedes this once it lands.
const BANNED_PART =
  /^(ai|assistant|agent|model|prompt|llm|token|claude|codex|opencode|chatgpt|anthropic|openai|gpt|copilot|bot|mcp|sdk|cli|subagent|provider|hidegpt)$/i

/** A server or tool name with vendor and banned words removed, or '' when nothing is left. */
const neutralPart = (name: string) =>
  name
    .split(/[\s_.:-]+/)
    .filter((part) => part && !BANNED_PART.test(part))
    .join(' ')

/**
 * "{app} · {tool}" for an `mcp__server__tool` name. A server named after the vendor
 * (`claude_ai_Notion`) reads as "Notion"; one with nothing left reads "A connected app".
 */
function connectedAppTitle(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  const app = displayServerName(neutralPart(match?.[1] ?? ''))
  const tool = neutralPart(match?.[2] ?? '')
  return tool ? `${app} · ${tool}` : app
}

/** The callout title for a step: running or done, by kind. An MCP tool needs its raw `name`. */
export function toolTitle(kind: ToolKind, done: boolean, name = ''): string {
  if (kind === 'mcp_tool') return connectedAppTitle(name)
  const titles = TITLES[kind]
  return done ? titles.done : titles.running
}

const DONE_BY_RUNNING = new Map(Object.values(TITLES).map((titles) => [titles.running, titles.done]))

/** The finished form of a running title; titles with one form come back unchanged. */
export const finishedTitle = (title: string): string => DONE_BY_RUNNING.get(title) ?? title
