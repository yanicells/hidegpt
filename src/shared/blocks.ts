import type { Block, UserBlock } from './model'

type Blocks = ReadonlyArray<Block>

/**
 * Pure, immutable block-list updates shared by every provider. Each returns
 * the same array when nothing visible changed, so unchanged references keep
 * IPC diffs and React memoization cheap.
 */

/** Ids of optimistic user echoes the session manager inserts before the server confirms a send. */
export const isLocalEcho = (block: Block): block is UserBlock => block.kind === 'user' && block.id.startsWith('local-')

/**
 * Inserts or replaces a block by id. A server user message replaces its
 * optimistic echo: by `replaces` (the client id sent with the turn) when the
 * provider echoes it back, otherwise by matching text on the newest echo.
 */
export function upsertBlock(blocks: Blocks, next: Block, replaces?: string | null): Blocks {
  const index = blocks.findIndex((block) => block.id === next.id)
  if (index === -1) {
    const echo = next.kind === 'user' ? findEcho(blocks, next, replaces) : -1
    if (echo !== -1) {
      const copy = blocks.slice()
      copy[echo] = next
      return copy
    }
    return [...blocks, next]
  }
  const previous = blocks[index]
  // A resolved/pending approval keeps its local state when the provider re-sends it.
  if (previous.kind === 'approval' && next.kind === 'approval') {
    return replaceAt(blocks, index, {
      ...next,
      resolved: previous.resolved ?? next.resolved,
      pending: previous.pending,
    })
  }
  return replaceAt(blocks, index, next)
}

function findEcho(blocks: Blocks, next: UserBlock, replaces?: string | null): number {
  if (replaces) {
    const exact = blocks.findIndex((block) => block.id === replaces)
    if (exact !== -1) return exact
  }
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]
    if (isLocalEcho(block) && block.text === next.text && (block.images?.length ?? 0) === (next.images?.length ?? 0)) {
      return i
    }
  }
  return -1
}

/** Appends streamed text to an agent block (or callout body), creating it on the first delta. */
export function appendText(
  blocks: Blocks,
  id: string,
  delta: string,
  create: { kind: 'agent' } | { kind: 'callout'; title: string } = { kind: 'agent' },
): Blocks {
  if (!delta) return blocks
  const index = blocks.findIndex((block) => block.id === id)
  if (index === -1) {
    const block: Block =
      create.kind === 'agent'
        ? { kind: 'agent', id, text: delta }
        : { kind: 'callout', id, title: create.title, body: delta }
    return [...blocks, block]
  }
  const current = blocks[index]
  if (current.kind === 'agent') return replaceAt(blocks, index, { ...current, text: current.text + delta })
  if (current.kind === 'callout') return replaceAt(blocks, index, { ...current, body: current.body + delta })
  return blocks
}

/** Prepends an older page, skipping anything already on the page. */
export function mergeOlderBlocks(older: Blocks, current: Blocks): Blocks {
  const seen = new Set(current.map((block) => block.id))
  const fresh = older.filter((block) => !seen.has(block.id))
  return fresh.length ? [...fresh, ...current] : current
}

export function updateApproval(
  blocks: Blocks,
  id: string,
  update: { resolved?: 'accepted' | 'skipped' | null; pending?: boolean },
): Blocks {
  const index = blocks.findIndex((block) => block.id === id)
  const current = blocks[index]
  if (!current || current.kind !== 'approval') return blocks
  return replaceAt(blocks, index, { ...current, ...update })
}

/** Approvals still waiting on the person (kept across a provider-side reload). */
export function openApprovals(blocks: Blocks): Blocks {
  return blocks.filter((block) => block.kind === 'approval' && block.resolved === null)
}

function replaceAt(blocks: Blocks, index: number, block: Block): Blocks {
  const copy = blocks.slice()
  copy[index] = block
  return copy
}
