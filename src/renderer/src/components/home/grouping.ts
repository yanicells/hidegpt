import type { Snapshot } from '../../../../codex/types'
import type { HomeView } from './useHomeView'

export type Thread = Snapshot['threads'][number]

export type Section = { key: string; title: string; kind: 'recent' | 'folder'; threads: Thread[] }

export function groupThreads(snap: Snapshot, view: HomeView): Section[] {
  const query = snap.search.trim().toLowerCase()
  const visible = query
    ? snap.threads.filter((thread) => `${thread.name ?? ''} ${thread.preview}`.toLowerCase().includes(query))
    : snap.threads
  const byProject = new Map<string, Thread[]>()
  const loose: Thread[] = []
  for (const thread of visible) {
    if (thread.projectId) {
      const list = byProject.get(thread.projectId) ?? []
      list.push(thread)
      byProject.set(thread.projectId, list)
    } else {
      loose.push(thread)
    }
  }
  const known = new Set(snap.projects.map((project) => project.id))
  const orphans = [...byProject.entries()].filter(([id]) => !known.has(id))
  const recent: Section[] =
    view === 'list'
      ? groupByRecency(loose)
      : [{ key: 'recent', title: 'Recent documents', kind: 'recent', threads: loose }]
  const sections: Section[] = [
    ...recent,
    ...snap.projects.map((project) => ({
      key: `p-${project.id}`,
      title: project.name,
      kind: 'folder' as const,
      threads: byProject.get(project.id) ?? [],
    })),
    ...orphans.map(([id, threads]) => ({
      key: `orphan-${id}`,
      title: folderName(threads),
      kind: 'folder' as const,
      threads,
    })),
  ]
  return sections.filter((section) => section.threads.length > 0 || section.kind === 'recent')
}

/** Orphan threads belong to a project we can't resolve — name the folder after their directory. */
function folderName(threads: Thread[]): string {
  const counts = new Map<string, number>()
  for (const thread of threads) {
    const base = (thread.cwd ?? '').replace(/\/+$/, '').split('/').pop()
    if (!base) continue
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [base, count] of counts) {
    if (count > bestCount) {
      best = base
      bestCount = count
    }
  }
  return best || 'Folder'
}

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
