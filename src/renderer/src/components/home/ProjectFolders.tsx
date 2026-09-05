import { useState } from 'react'
import type { Snapshot } from '../../../../codex/types'
import { FolderIcon, PlusMonoIcon } from '../ui/Icons'

export function projectFolders(snap: Snapshot) {
  const folders = snap.projects.map((project) => ({
    id: project.id,
    name: project.name,
    cwd: project.roots[0]?.path ?? snap.threads.find((thread) => thread.projectId === project.id)?.cwd,
    count: snap.threads.filter((thread) => thread.projectId === project.id).length,
  }))
  const known = new Set(folders.map((folder) => folder.id))
  for (const thread of snap.threads) {
    if (!thread.projectId || known.has(thread.projectId)) continue
    known.add(thread.projectId)
    folders.push({
      id: thread.projectId,
      name: thread.cwd.split('/').filter(Boolean).pop() || 'Project',
      cwd: thread.cwd,
      count: snap.threads.filter((item) => item.projectId === thread.projectId).length,
    })
  }
  return folders
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
