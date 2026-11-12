import {
  isFinalRequestStatus,
  type AssistantItem,
  type Item,
  type RequestStatus,
  type ToolItem,
  type UserItem,
} from '../../provider/events'

type Items = ReadonlyArray<Item>

/**
 * Pure, immutable updates to a document's item list. Each returns the same
 * array when nothing changed, and every item it does not touch keeps its
 * reference, so `presentItem`'s cache and the reference diff behind snapshot
 * patches stay cheap. Lookups scan from the end: the item being streamed or
 * answered is nearly always the newest.
 */

/** Ids of optimistic user echoes the session manager inserts before the server confirms a send. */
export const isLocalEcho = (item: Item): item is UserItem => item.kind === 'user' && item.id.startsWith('local-')

/** A request still waiting on the person, or on the reply they just sent. */
export const isOpenRequest = (item: Item): boolean =>
  item.kind === 'request' && (item.status === 'pending' || item.status === 'sending')

function lastIndexOf(items: Items, id: string): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (items[i]!.id === id) return i
  return -1
}

function replaceAt(items: Items, index: number, item: Item): Items {
  const copy = items.slice()
  copy[index] = item
  return copy
}

/**
 * Inserts or replaces an item by id. A server user message replaces its
 * optimistic echo: by `replaces` (the client id sent with the turn) when the
 * provider echoes it back, otherwise by matching text on the newest echo. A
 * request re-sent as `pending` keeps what the person already did with it.
 */
export function upsertItem(items: Items, next: Item, replaces?: string | null): Items {
  const index = lastIndexOf(items, next.id)
  if (index === -1) {
    const echo = next.kind === 'user' ? findEcho(items, next, replaces) : -1
    return echo === -1 ? [...items, next] : replaceAt(items, echo, next)
  }
  const previous = items[index]!
  if (previous.kind === 'request' && next.kind === 'request' && next.status === 'pending') {
    return replaceAt(items, index, { ...next, status: previous.status })
  }
  return replaceAt(items, index, next)
}

function findEcho(items: Items, next: UserItem, replaces?: string | null): number {
  if (replaces) {
    const exact = lastIndexOf(items, replaces)
    if (exact !== -1) return exact
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!
    if (isLocalEcho(item) && item.text === next.text && (item.images?.length ?? 0) === (next.images?.length ?? 0)) {
      return i
    }
  }
  return -1
}

/**
 * Appends streamed text to an assistant item's text or a tool item's output.
 * An id not on the page yet starts from `create`; without it the delta is dropped.
 */
export function appendDelta(items: Items, id: string, delta: string, create?: AssistantItem | ToolItem): Items {
  if (!delta) return items
  const index = lastIndexOf(items, id)
  if (index === -1) return create ? [...items, grow(create, delta)] : items
  const current = items[index]!
  return current.kind === 'assistant' || current.kind === 'tool' ? replaceAt(items, index, grow(current, delta)) : items
}

function grow(item: AssistantItem | ToolItem, delta: string): AssistantItem | ToolItem {
  return item.kind === 'assistant' ? { ...item, text: item.text + delta } : { ...item, output: item.output + delta }
}

/** Prepends an older page, skipping anything already on the page. */
export function mergeOlderItems(older: Items, current: Items): Items {
  const seen = new Set(current.map((item) => item.id))
  const fresh = older.filter((item) => !seen.has(item.id))
  return fresh.length ? [...fresh, ...current] : current
}

export function setRequestStatus(items: Items, id: string, status: RequestStatus): Items {
  const index = lastIndexOf(items, id)
  const current = items[index]
  if (!current || current.kind !== 'request' || current.status === status) return items
  return replaceAt(items, index, { ...current, status })
}

/** Requests still open (kept across a provider-side reload). */
export function openRequests(items: Items): Items {
  return items.filter(isOpenRequest)
}

/** The turn ended: every request still waiting on the person can no longer be answered. */
export function expireRequests(items: Items): Items {
  if (!items.some((item) => item.kind === 'request' && !isFinalRequestStatus(item.status))) return items
  return items.map((item) =>
    item.kind === 'request' && !isFinalRequestStatus(item.status) ? { ...item, status: 'expired' } : item,
  )
}
