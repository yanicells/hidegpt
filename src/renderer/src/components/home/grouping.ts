import type { Snapshot } from '../../../../codex/types'

export type Thread = Snapshot['threads'][number]

export type Section = { key: string; title: string; kind: 'recent' | 'folder'; threads: Thread[] }

function toMs(raw: number): number {
  return raw >= 1e11 ? raw : raw * 1000
}

function dayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000
}

export function groupByRecency(threads: Thread[]): Section[] {
  const buckets: Record<string, Thread[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 days': [],
    'Previous 30 days': [],
    Older: [],
  }
  const today = dayNumber(new Date())
  for (const thread of threads) {
    const at = new Date(toMs(thread.recencyAt ?? thread.updatedAt ?? 0))
    const age = today - dayNumber(at)
    if (age <= 0) buckets.Today.push(thread)
    else if (age === 1) buckets.Yesterday.push(thread)
    else if (age <= 7) buckets['Previous 7 days'].push(thread)
    else if (age <= 30) buckets['Previous 30 days'].push(thread)
    else buckets.Older.push(thread)
  }
  return Object.entries(buckets)
    .filter(([, items]) => items.length > 0)
    .map(([title, items]) => ({ key: `recent-${title}`, title, kind: 'recent' as const, threads: items }))
}
