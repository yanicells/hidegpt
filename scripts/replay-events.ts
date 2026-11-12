/**
 * Replays an activity log through the app's reducer and prints, per document,
 * each turn (when it started, how it ended) and the items it was left with.
 * A turn still open at the end is the "Working…" that never went away.
 *
 *   pnpm replay:events ~/Library/Application\ Support/<app>/logs/activity/personal.ndjson
 *
 * The log holds no text, so items print as kinds and statuses only.
 */
import { readFileSync } from 'node:fs'

import type { Item } from '../src/provider/events.ts'

// src/shared/labels.ts reads the build flag electron-vite defines; any value works for a replay.
Object.assign(globalThis, { __HIDEGPT_PERSONAL__: true })
const { replayEventLog, replayedRuntime } = await import('../src/main/session/replay.ts')

const describeItem = (item: Item): string => {
  switch (item.kind) {
    case 'tool':
      return `tool:${item.tool}(${item.status})`
    case 'request':
      return `request:${item.request}(${item.status})`
    case 'notice':
      return `notice:${item.notice}`
    case 'assistant':
      return `assistant:${item.phase}`
    case 'user':
      return 'user'
  }
}

const file = process.argv[2]
if (!file) {
  console.error('Usage: pnpm replay:events <logs/activity/<library>.ndjson>')
  process.exit(1)
}

const replay = replayEventLog(readFileSync(file, 'utf8').split('\n'))
console.log(`${replay.events} events, ${replay.skipped} other lines`)
for (const thread of replay.threads) {
  console.log(`\n${thread.provider} ${thread.threadId}`)
  for (const turn of thread.turns) {
    const ended = turn.endedAt
      ? `${turn.status}${turn.failure ? ` (${turn.failure})` : ''} at ${turn.endedAt}`
      : 'STILL OPEN'
    console.log(`  turn ${turn.turnId}  started ${turn.startedAt}  ${ended}`)
  }
  const runtime = replayedRuntime(replay, thread.provider, thread.threadId)
  if (!runtime) console.log('  closed')
  else console.log(`  items: ${runtime.items.map(describeItem).join(', ') || 'none'}`)
}
