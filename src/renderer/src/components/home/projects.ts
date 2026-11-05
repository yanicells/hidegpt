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

/** A project shown as a Drive folder. */
export type Folder = ReturnType<typeof projectFolders>[number]

/** Projects as Drive folders; a folder was last modified when its newest loaded document was. */
export function projectFolders(snap: Snapshot) {
  const folders = new Map(
    snap.projects.map((project) => [
      project.id,
      {
        id: project.id,
        name: project.name,
        cwd: project.roots[0]?.path,
        updatedAt: null as number | null,
      },
    ]),
  )
  for (const thread of snap.threads) {
    const id = threadProjectId(snap, thread)
    if (!id) continue
    let folder = folders.get(id)
    if (!folder) {
      folder = { id, name: thread.cwd.split('/').filter(Boolean).pop() || 'Project', cwd: thread.cwd, updatedAt: null }
      folders.set(id, folder)
    }
    const touched = thread.recencyAt ?? thread.updatedAt ?? null
    if (touched && (!folder.updatedAt || touched > folder.updatedAt)) folder.updatedAt = touched
    folder.cwd ||= thread.cwd
  }
  return [...folders.values()]
}
