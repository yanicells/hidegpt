import { useState } from 'react'
import type { Snapshot } from '../../../../codex/types'
import { FolderIcon, PlusMonoIcon } from '../ui/Icons'

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

export function ProjectFolders({
  snap,
  onOpen,
  onAdd,
}: {
  snap: Snapshot
  onOpen: (id: string) => void
  onAdd: () => void
}) {
  const folders = projectFolders(snap)
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? folders : folders.slice(0, 4)
  return (
    <section className="projects-section" aria-label="Projects">
      <div className="projects-heading">
        <h2>Projects</h2>
        <button className="text-button" onClick={onAdd}>
          <PlusMonoIcon />
          Add project
        </button>
      </div>
      {folders.length ? (
        <div className="folder-grid">
          {visible.map((folder) => (
            <button
              key={folder.id}
              className="folder-card"
              data-testid={`project-${folder.id}`}
              onClick={() => onOpen(folder.id)}
            >
              <FolderIcon />
              <span>
                <strong>{folder.name}</strong>
                <small>
                  {folder.count} {snap.search ? 'matching ' : ''}
                  {folder.count === 1 ? 'document' : 'documents'}
                </small>
              </span>
              <span className="folder-arrow" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="project-empty">Keep related documents together. Add a project to get started.</p>
      )}
      {folders.length > 4 ? (
        <button className="text-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer projects' : `Show all ${folders.length} projects`}
        </button>
      ) : null}
    </section>
  )
}
