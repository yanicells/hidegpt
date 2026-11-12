import { displayServerName } from '../../shared/labels'
import type { ApprovalBlock, Block, CalloutBlock, DocSummary, Snapshot } from '../../shared/model'
import { isStealthy, neutralizeName, neutralizeSentence, stripVendorWords } from '../../shared/stealth'

/**
 * The last check before a snapshot leaves main: chrome text the adapters wrote
 * (tool and request titles, request sentences, error text), the document's
 * title and the titles on Home are put into Docs wording. Content is never
 * touched: the answer, the person's text, callout bodies, commands and paths,
 * and question text stay exactly as the provider sent them.
 *
 * Known adapter wording maps to the neutral wording agreed for `present.ts`
 * (STL-2 in the stealth audit), so nothing reads differently once the typed
 * items land; anything else gets `neutralizeSentence`, and text that still
 * reads as tooling falls back to a plain phrase. Once every title comes from
 * `present.ts`, the tables here empty out and the filter stays as the guard
 * for names the provider passes through.
 */

// ---- tool rows (callout titles) ------------------------------------------------

/** A tool, by the raw name an adapter puts in "Using X", "Used X" or "Ran X". Lower case. */
const TOOL_ROWS: Readonly<Record<string, string>> = {
  bash: 'Ran a command',
  read: 'Opened a file',
  edit: 'Edited a file',
  write: 'Edited a file',
  multiedit: 'Edited a file',
  notebookedit: 'Edited a file',
  apply_patch: 'Edited a file',
  patch: 'Edited a file',
  grep: 'Searched files',
  glob: 'Searched files',
  websearch: 'Looked something up',
  webfetch: 'Opened a link',
  task: 'Background task',
  agent: 'Background task',
  todowrite: 'Updated the checklist',
}

const CALLOUT_TITLES: Readonly<Record<string, string>> = {
  'Generated image': 'Image',
  'Compacted context': 'Earlier content summarized',
}

/** A raw tool name: one token, as `Read`, `apply_patch` or `mcp__server__tool`. */
const TOOL_STEP = /^(?:Using|Used|Ran) ([\w.:-]+)$/
const MCP_TOOL = /^mcp__(.+?)__(.+)$/
const SERVER_TOOL = /^(.+?) · (.+)$/

/** "App · Tool", from names a provider gave; a plain phrase if the pair still reads as tooling. */
function appAndTool(server: string, tool: string): string {
  return sentenceOr(`${displayServerName(server)} · ${neutralizeName(tool, 'Step')}`, 'Used a connected app')
}

/** The tool row's title in Docs wording. */
export function calloutTitle(title: string): string {
  const fixed = CALLOUT_TITLES[title]
  if (fixed) return fixed
  // Codex names a subtask by its tool ("Subtask · spawn_agent").
  if (title.startsWith('Subtask · ')) return 'Background task'
  const step = TOOL_STEP.exec(title)
  if (step) {
    const name = step[1]!
    const mcp = MCP_TOOL.exec(name)
    return mcp ? appAndTool(mcp[1]!, mcp[2]!) : (TOOL_ROWS[name.toLowerCase()] ?? 'Did a step')
  }
  const pair = SERVER_TOOL.exec(title)
  if (pair) return appAndTool(pair[1]!, pair[2]!)
  return sentenceOr(title, 'Did a step')
}

// ---- requests (approval titles and bodies) -----------------------------------------

/**
 * Every fixed request title the adapters write, here and on `32-combined`
 * (`codex/mapping.ts` APPROVALS, `claude/mapping.ts` permissionBlock and
 * questionBlock, `opencode/mapping.ts` permissionBlock and questionBlock,
 * `present.ts` REQUESTS), as STL-2's Docs wording.
 */
const APPROVAL_TITLES: Readonly<Record<string, string>> = {
  'Run command?': 'Suggested command',
  'Apply file changes?': 'Suggested edit',
  'Edit files?': 'Suggested edit',
  'Grant extra access?': 'Access request',
  'Allow more access?': 'Access request',
  'Allow this tool?': 'Allow this step?',
  'Waiting for your response': 'Needs your reply',
  'The assistant needs input': 'Needs your reply',
  'Claude needs input': 'Needs your reply',
}

/** A tool or permission asking to run, by its raw name in "Allow X?" or "Allow X: patterns?". Lower case. */
const APPROVAL_KINDS: Readonly<Record<string, string>> = {
  bash: 'Run this command?',
  read: 'Open this file?',
  edit: 'Edit this file?',
  write: 'Edit this file?',
  multiedit: 'Edit this file?',
  notebookedit: 'Edit this file?',
  apply_patch: 'Edit this file?',
  websearch: 'Look this up online?',
  webfetch: 'Look this up online?',
}

/** OpenCode's permission body on `32-combined`; today's ("More access is needed to continue.") is already plain. */
const OPENCODE_ACCESS_BODY = 'The assistant is asking for extra access.'

const ALLOW = /^Allow (.+?)(?:: (.+))?\?$/
const CONTINUE_WITH = /^Continue with (.+)\?$/

/**
 * "Allow X?" names a tool (Claude, OpenCode) or a connected app (Codex). A
 * known tool kind reads as its Docs question, a raw tool name (`mcp__…`) or a
 * permission with patterns as "Allow this step?", and an app keeps its name
 * when that name is clean: "Allow Notion?" stays, "Allow claude_ai_Notion?"
 * reads "Allow Notion?".
 */
function allowTitle(name: string, patterns: string | undefined): string {
  const kind = APPROVAL_KINDS[name.toLowerCase()]
  if (kind) return kind
  if (patterns !== undefined || name.includes('__')) return 'Allow this step?'
  return isStealthy(name) ? `Allow ${name}?` : `Allow ${neutralizeName(name, 'this step')}?`
}

/** The request card's title and body in Docs wording; fields, questions and replies are untouched. */
function approvalText(block: ApprovalBlock): { title: string; body: string } {
  const allow = ALLOW.exec(block.title)
  // OpenCode puts the permission's patterns in the title; they are what the card suggests.
  const patterns = allow?.[2]
  const body = patterns ?? (block.body === OPENCODE_ACCESS_BODY ? 'More access is needed to continue.' : block.body)
  const fixed = APPROVAL_TITLES[block.title]
  if (fixed) return { title: fixed, body }
  if (allow) return { title: allowTitle(allow[1]!, patterns), body }
  const app = CONTINUE_WITH.exec(block.title)
  if (app) return { title: `Continue with ${displayServerName(app[1]!)}?`, body }
  return { title: sentenceOr(block.title, 'Allow this step?'), body }
}

// ---- errors -------------------------------------------------------------------------

/** Today's adapter sentences by failure class, with the class's Docs sentence. */
const FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/did not answer in [\d.]+ s/i, 'Docs is taking longer than usual. Try again, or use Tools → Refresh.'],
  [/stopped unexpectedly/i, 'Docs lost its connection and is reconnecting.'],
  [/is not installed \(Docs could not run/i, 'This account isn’t set up on this computer yet.'],
  [
    /signs in outside Docs|has no model providers set up/i,
    'This account signs in outside Docs. Sign in, then use Tools → Refresh.',
  ],
  [
    /is open in ChatGPT or another window/i,
    'This document is open in another window. Close it there, then open it here.',
  ],
  [/reaching its (?:step|spending) limit/i, 'You’ve reached this account’s limit. Try again later.'],
  [
    /^(?:Claude|The assistant) ran into an error\.$|model provider failed the request|^Claude (?:could not finish the answer|stopped before finishing)\.$/i,
    'Docs couldn’t finish. Try again.',
  ],
  [/^Docs could not load \w+\./, 'Docs couldn’t open this library. Docs saved a report.'],
  [/^Pick a model first\.$/, 'Choose a text style first.'],
  [/^Sign in with ChatGPT to refresh this session\.$/, 'Sign in again to refresh this session.'],
]

/**
 * An error sentence as the page may show it (the banner's "Details", a
 * command's rejection). Known failures read as their class's sentence; any
 * other has vendor names replaced, or becomes a plain sentence if it still
 * reads as tooling. The raw text stays in the log.
 */
export function neutralizeError(message: string): string {
  for (const [pattern, sentence] of FAILURES) if (pattern.test(message)) return sentence
  return sentenceOr(message, 'Something went wrong. Try again.')
}

/** `neutralizeSentence`, or `fallback` when the result still holds a banned word. */
function sentenceOr(text: string, fallback: string): string {
  const neutral = neutralizeSentence(text)
  return isStealthy(neutral) ? neutral : fallback
}

// ---- the snapshot -----------------------------------------------------------------------

// Identity matters: `diffSnapshot` skips a block (or the whole list) whose reference is
// unchanged, so the same input must always give back the same output object.
const filteredBlocks = new WeakMap<Block, Block>()
const filteredLists = new WeakMap<ReadonlyArray<Block>, ReadonlyArray<Block>>()

function filterCallout(block: CalloutBlock): CalloutBlock {
  const title = calloutTitle(block.title)
  return title === block.title ? block : { ...block, title }
}

function filterApproval(block: ApprovalBlock): ApprovalBlock {
  const { title, body } = approvalText(block)
  return title === block.title && body === block.body ? block : { ...block, title, body }
}

function filterBlock(block: Block): Block {
  if (block.kind !== 'callout' && block.kind !== 'approval') return block
  let filtered = filteredBlocks.get(block)
  if (!filtered) {
    filtered = block.kind === 'callout' ? filterCallout(block) : filterApproval(block)
    filteredBlocks.set(block, filtered)
  }
  return filtered
}

function filterBlocks(blocks: ReadonlyArray<Block>): ReadonlyArray<Block> {
  const cached = filteredLists.get(blocks)
  if (cached) return cached
  let copy: Block[] | null = null
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!
    const filtered = filterBlock(block)
    if (filtered !== block) (copy ??= blocks.slice())[index] = filtered
  }
  const result = copy ?? blocks
  filteredLists.set(blocks, result)
  return result
}

const filteredThreads = new WeakMap<ReadonlyArray<DocSummary>, ReadonlyArray<DocSummary>>()

/**
 * Home's documents with vendor names out of their titles ("Claude Code
 * session" reads "session"). A name with nothing left reads "Untitled
 * document" rather than null, so Home does not fall back to the preview,
 * which can hold the same title.
 */
function filterThreads(threads: ReadonlyArray<DocSummary>): ReadonlyArray<DocSummary> {
  const cached = filteredThreads.get(threads)
  if (cached) return cached
  let copy: DocSummary[] | null = null
  for (let index = 0; index < threads.length; index++) {
    const thread = threads[index]!
    const name = thread.name === null ? null : stripVendorWords(thread.name, 'Untitled document')
    if (name !== thread.name) (copy ??= threads.slice())[index] = { ...thread, name }
  }
  const result = copy ?? threads
  filteredThreads.set(threads, result)
  return result
}

/** `fn` remembering its last answer: the title and error are the same string on almost every publish. */
function lastOf(fn: (text: string) => string): (text: string) => string {
  let input: string | null = null
  let output = ''
  return (text) => {
    if (text !== input) {
      input = text
      output = fn(text)
    }
    return output
  }
}

const filterError = lastOf(neutralizeError)
const filterTitle = lastOf((title) => stripVendorWords(title, 'Untitled document'))

/** The snapshot as the window may see it. Returns the input itself when nothing needed changing. */
export function filterSnapshot(snapshot: Snapshot): Snapshot {
  const blocks = filterBlocks(snapshot.blocks)
  const threads = filterThreads(snapshot.threads)
  const error = snapshot.error === null ? null : filterError(snapshot.error)
  const title = filterTitle(snapshot.title)
  if (
    blocks === snapshot.blocks &&
    threads === snapshot.threads &&
    error === snapshot.error &&
    title === snapshot.title
  ) {
    return snapshot
  }
  return { ...snapshot, blocks, threads, error, title }
}
