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

const TOOL_TITLES: Record<ToolKind, Record<ToolStatus, string>> = {
  command: { running: 'Running a command', completed: 'Ran a command', failed: 'A command didn’t finish' },
  file_change: { running: 'Editing files', completed: 'Edited files', failed: 'Couldn’t edit files' },
  file_search: { running: 'Searching files', completed: 'Searched files', failed: 'Couldn’t search files' },
  web_search: { running: 'Looking something up', completed: 'Looked something up', failed: 'Couldn’t look that up' },
  mcp_tool: {
    running: 'Using a connected app',
    completed: 'Used a connected app',
    failed: 'A connected app didn’t respond',
  },
  subagent: { running: 'Working on a subtask', completed: 'Finished a subtask', failed: 'A subtask didn’t finish' },
  compaction: { running: 'Compacting context', completed: 'Compacted context', failed: 'Couldn’t compact context' },
  review: { running: 'Reviewing', completed: 'Reviewed', failed: 'The review didn’t finish' },
  other: { running: 'Working on a step', completed: 'Finished a step', failed: 'A step didn’t finish' },
}

/** Each request as a Docs suggestion: its verb (see `Approval.tsx`) and its card title. */
const REQUESTS: Record<RequestKind, { readonly suggestion: SuggestionKind; readonly title: string }> = {
  command: { suggestion: 'add', title: 'Run command?' },
  file_change: { suggestion: 'replace', title: 'Apply file changes?' },
  permissions: { suggestion: 'format', title: 'Grant extra access?' },
  tool_access: { suggestion: 'add', title: 'Allow this step?' },
  user_input: { suggestion: 'question', title: 'Waiting for your response' },
  form: { suggestion: 'add', title: 'Fill in these details?' },
}

const NOTICE_TITLES: Record<NoticeKind, string> = {
  retrying: 'Trying again',
  compacted: 'Compacted context',
  warning: 'Heads up',
}

const FAILURES: Record<FailureClass, string> = {
  usage_limit: 'You’ve reached your usage limit. Try again later.',
  auth: 'Docs needs you to sign in again.',
  provider_error: 'Docs couldn’t finish that. Try again.',
  transport_error: 'Docs lost its connection. Try again in a moment.',
  validation_error: 'Docs couldn’t send that. Change it and try again.',
  unknown: 'Something went wrong. Try again.',
}

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

/** The blocks for a list; the same array for the same list, and the same block for each unchanged item. */
export function presentItems(items: ReadonlyArray<Item>): ReadonlyArray<Block> {
  let blocks = blocksOf.get(items)
  if (!blocks) {
    blocks = items.map(presentItem)
    blocksOf.set(items, blocks)
  }
  return blocks
}

/** The banner sentence for a failed turn. The provider's own text (`detail`) never reaches the page. */
export function presentFailure(failure: Failure): string {
  if (failure.class === 'usage_limit' && failure.resetAt !== null) {
    const at = new Date(failure.resetAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    return `You’ve reached your usage limit. Try again after ${at}.`
  }
  return FAILURES[failure.class]
}
