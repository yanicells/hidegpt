import type {
  Failure,
  FailureClass,
  Item,
  NoticeKind,
  RequestItem,
  RequestKind,
  ToolItem,
  ToolKind,
  ToolStatus,
} from '../../provider/events'
import { displayServerName } from '../../shared/labels'
import type { ApprovalBlock, Block, SuggestionKind } from '../../shared/model'
import { isStealthy } from '../../shared/stealth'

/**
 * The one place main turns data into words on the page. Adapters report what
 * happened (`tool: 'command'`, `request: 'file_change'`); this file says it
 * the way Docs would. `present.test.ts` runs every string here through the
 * stealth gate (`src/shared/stealth.ts`).
 *
 * Presented blocks are cached per item object: an unchanged item returns the
 * same block, and an unchanged list the same array. `diffSnapshot` compares
 * by reference, so without the cache every streamed delta would resend every
 * block.
 */

// Tool rows, requests and failures follow the stealth audit's tables (STL-2).
const TOOL_TITLES: Record<ToolKind, Record<ToolStatus, string>> = {
  command: { running: 'Running a command', completed: 'Ran a command', failed: 'A command didn’t finish' },
  file_read: { running: 'Opening a file', completed: 'Opened a file', failed: 'Couldn’t open a file' },
  file_change: { running: 'Editing a file', completed: 'Edited a file', failed: 'Couldn’t edit a file' },
  file_search: { running: 'Searching files', completed: 'Searched files', failed: 'Couldn’t search files' },
  web_search: { running: 'Looking something up', completed: 'Looked something up', failed: 'Couldn’t look that up' },
  web_fetch: { running: 'Opening a link', completed: 'Opened a link', failed: 'Couldn’t open a link' },
  mcp_tool: {
    running: 'Using a connected app',
    completed: 'Used a connected app',
    failed: 'A connected app didn’t respond',
  },
  subagent: { running: 'Background task', completed: 'Background task', failed: 'A background task didn’t finish' },
  compaction: {
    running: 'Summarizing earlier content',
    completed: 'Earlier content summarized',
    failed: 'Couldn’t summarize earlier content',
  },
  review: { running: 'Reviewing', completed: 'Reviewed', failed: 'The review didn’t finish' },
  other: { running: 'Doing a step', completed: 'Did a step', failed: 'A step didn’t finish' },
}

/** Each request as a Docs suggestion: its verb (see `Approval.tsx`) and its card title. */
const REQUESTS: Record<RequestKind, { readonly suggestion: SuggestionKind; readonly title: string }> = {
  command: { suggestion: 'add', title: 'Suggested command' },
  file_change: { suggestion: 'replace', title: 'Suggested edit' },
  permissions: { suggestion: 'format', title: 'Access request' },
  tool_access: { suggestion: 'add', title: 'Allow this step?' },
  user_input: { suggestion: 'question', title: 'Needs your reply' },
  form: { suggestion: 'add', title: 'Fill in these details?' },
}

/** What a card asks before a tool of this kind runs (Claude tools, OpenCode permissions). */
const TOOL_REQUESTS: Record<ToolKind, string> = {
  command: 'Run this command?',
  file_read: 'Open this file?',
  file_change: 'Edit this file?',
  file_search: 'Open this file?',
  web_search: 'Look this up online?',
  web_fetch: 'Look this up online?',
  mcp_tool: 'Allow this step?',
  subagent: 'Allow this step?',
  compaction: 'Allow this step?',
  review: 'Allow this step?',
  other: 'Allow this step?',
}

const NOTICE_TITLES: Record<NoticeKind, string> = {
  retrying: 'Trying again',
  compacted: 'Earlier content summarized',
  warning: 'Heads up',
}

const FAILURES: Record<FailureClass, string> = {
  usage_limit: 'You’ve reached this account’s limit. Try again later.',
  auth: 'This account signs in outside Docs. Sign in, then use Tools → Refresh.',
  provider_error: 'Docs couldn’t finish. Try again.',
  transport_error: 'Docs lost its connection and is reconnecting.',
  validation_error: 'Docs couldn’t send that. Change it and try again.',
  unknown: 'Docs couldn’t finish. Try again.',
}

/**
 * A tool row's title. Adapters that still title their own rows (the legacy
 * contract) take it from here, so the wording lives in this file only.
 */
export const toolTitle = (kind: ToolKind, status: ToolStatus): string => TOOL_TITLES[kind][status]

/**
 * A connected app's tool row: "{app} · {tool}", or the app alone. Both names
 * must already be neutral (`src/provider/toolTitles.ts`); an empty app reads
 * "A connected app".
 */
export const connectedAppTitle = (app: string, tool: string): string =>
  tool ? `${displayServerName(app)} · ${tool}` : displayServerName(app)

/** The card question before a tool runs; a connected app is named when its neutral name is known. */
export const toolRequestTitle = (kind: ToolKind, app = ''): string =>
  kind === 'mcp_tool' && app ? `Use ${displayServerName(app)}?` : TOOL_REQUESTS[kind]

/** A legacy adapter's own title, unless it would name a model or vendor on the page. */
const titleOf = (item: ToolItem | RequestItem, typed: string): string =>
  item.legacy && isStealthy(item.legacy.title) ? item.legacy.title : typed

function present(item: Item): Block {
  switch (item.kind) {
    // The user item is already the block's shape; returning it keeps one object per message.
    case 'user':
      return item
    case 'assistant':
      return {
        kind: 'agent',
        id: item.id,
        text: item.text,
        ...(item.phase === 'commentary' ? { commentary: true } : {}),
      }
    case 'tool':
      return {
        kind: 'callout',
        id: item.id,
        title: titleOf(item, TOOL_TITLES[item.tool][item.status]),
        // The subject first, then what it printed, so streamed output only ever grows the end.
        body: item.subject && item.output ? `${item.subject}\n${item.output}` : (item.subject ?? item.output),
      }
    case 'request': {
      const { suggestion, title } = REQUESTS[item.request]
      return {
        kind: 'approval',
        id: item.id,
        suggestion,
        title: titleOf(item, title),
        body: item.subject ?? item.detail,
        fields: item.fields,
        questions: item.questions,
        resolved: RESOLVED[item.status],
        pending: item.status === 'sending',
      }
    }
    case 'notice':
      return { kind: 'callout', id: item.id, title: NOTICE_TITLES[item.notice], body: item.detail ?? '' }
  }
}

const RESOLVED: Record<RequestItem['status'], ApprovalBlock['resolved']> = {
  pending: null,
  sending: null,
  accepted: 'accepted',
  declined: 'skipped',
  expired: 'skipped',
}

const blockOf = new WeakMap<Item, Block>()
const blocksOf = new WeakMap<ReadonlyArray<Item>, ReadonlyArray<Block>>()

/** The block for an item; the same object for as long as the item object is unchanged. */
export function presentItem(item: Item): Block {
  let block = blockOf.get(item)
  if (!block) {
    block = present(item)
    blockOf.set(item, block)
  }
  return block
}

/**
 * The list last presented. A streamed delta replaces one item of the shown document's list,
 * so comparing against it by position skips a cache lookup for every unchanged item. The
 * stream bench (1,000 turns) spends 15-25% more CPU with the WeakMap lookups alone.
 */
let last: { readonly items: ReadonlyArray<Item>; readonly blocks: ReadonlyArray<Block> } | null = null

/** `previous.blocks`, copied, with each position whose item changed presented again. */
function patched(previous: NonNullable<typeof last>, items: ReadonlyArray<Item>): Block[] {
  const blocks = previous.blocks.slice(0, items.length)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    if (previous.items[index] !== item) blocks[index] = presentItem(item)
  }
  return blocks
}

/** The blocks for a list; the same array for the same list, and the same block for each unchanged item. */
export function presentItems(items: ReadonlyArray<Item>): ReadonlyArray<Block> {
  let blocks = blocksOf.get(items)
  if (!blocks) {
    blocks = last ? patched(last, items) : items.map(presentItem)
    blocksOf.set(items, blocks)
  }
  last = { items, blocks }
  return blocks
}

/**
 * The banner sentence for a failed turn, with its report id when it has one so
 * the log line can be found from the screen. The provider's own text
 * (`detail`) never reaches the page.
 */
export function presentFailure(failure: Failure): string {
  const sentence = failureSentence(failure)
  return failure.reportId ? `${sentence} (Report ${failure.reportId})` : sentence
}

function failureSentence(failure: Failure): string {
  if (failure.class === 'usage_limit' && failure.resetAt !== null) {
    const at = new Date(failure.resetAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    return `You’ve reached this account’s limit. Try again after ${at}.`
  }
  return FAILURES[failure.class]
}
