import type { Snapshot } from '../../../../codex/types'

/** The project a document belongs to: explicit id first, else the deepest matching folder root. */
export function threadProjectId(snap: Snapshot, thread: Snapshot['threads'][number]): string | null {
  if (thread.projectId) return thread.projectId
  const cwd = thread.cwd.replace(/\/+$/, '')
  let match: { id: string; length: number } | undefined
  for (const project of snap.projects) {
    for (const root of project.roots) {
      const path = root.path.replace(/\/+$/, '')
      if (path && (cwd === path || cwd.startsWith(`${path}/`)) && (!match || path.length > match.length)) {
        match = { id: project.id, length: path.length }
      }
    }
  }
  return match?.id ?? null
}

/** Projects as Drive folders, with how many of the loaded documents each holds. */
export function projectFolders(snap: Snapshot) {
  const folders = new Map(
    snap.projects.map((project) => [
      project.id,
      {
        id: project.id,
        name: project.name,
        cwd: project.roots[0]?.path,
        count: 0,
      },
    ]),
  )
  for (const thread of snap.threads) {
    const id = threadProjectId(snap, thread)
    if (!id) continue
    let folder = folders.get(id)
    if (!folder) {
      folder = { id, name: thread.cwd.split('/').filter(Boolean).pop() || 'Project', cwd: thread.cwd, count: 0 }
      folders.set(id, folder)
    }
    folder.count++
    folder.cwd ||= thread.cwd
  }
  return [...folders.values()]
}
