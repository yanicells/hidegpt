import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../../../../codex/types'
import { setPendingDraft, type Template } from '../../templates'
import { DocsIcon, FolderIcon } from '../ui/Icons'
import { projectFolders } from './ProjectFolders'

export type Creation = { template?: Template; projectId?: string; projectOnly?: boolean }

export function NewDocumentDialog({
  snap,
  creation,
  onClose,
}: {
  snap: Snapshot
  creation: Creation
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const created = useRef(false)
  const [title, setTitle] = useState('')
  const [location, setLocation] = useState(creation.projectId ?? '')
  const [folder, setFolder] = useState('')
  const [projectName, setProjectName] = useState('')
  const [adding, setAdding] = useState(Boolean(creation.projectOnly))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const folders = projectFolders(snap)
  const selected = folders.find((item) => item.id === location)

  useEffect(() => {
    const dialog = ref.current
    const previous = document.activeElement as HTMLElement | null
    if (dialog?.showModal) dialog.showModal()
    else dialog?.setAttribute('open', '')
    return () => {
      dialog?.close?.()
      if (created.current)
        document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')?.focus({ preventScroll: true })
      else previous?.focus()
    }
  }, [])

  const chooseFolder = async () => {
    try {
      const path = await window.hidegpt.pickDirectory()
      if (path) {
        setFolder(path)
        if (!projectName) setProjectName(path.split('/').pop() ?? '')
      }
    } catch (cause) {
      setError(String(cause))
    }
  }
  const saveProject = async () => {
    setBusy(true)
    setError('')
    try {
      await window.hidegpt.dispatch({ op: 'createProject', name: projectName.trim(), cwd: folder })
      const project = window.hidegpt
        .getSnapshot()
        .projects.find((item) => item.roots.some((root) => root.path === folder))
      if (!project) throw new Error('The project could not be found. Refresh and try again.')
      if (creation.projectOnly) {
        onClose()
        return
      }
      setLocation(project.id)
      setAdding(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const create = async () => {
    setBusy(true)
    setError('')
    try {
      setPendingDraft(creation.template?.prompt ?? '')
      await window.hidegpt.dispatch({
        op: 'newDocument',
        title: title.trim(),
        projectId: selected?.id ?? null,
        cwd: selected?.cwd ?? (location === 'folder' ? folder : undefined),
      })
      created.current = true
      onClose()
    } catch (cause) {
      setPendingDraft('')
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={ref}
      className="creation-dialog"
      aria-labelledby="creation-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void (adding ? saveProject() : create())
        }}
      >
        <div className="creation-heading">
          {adding ? <FolderIcon /> : <DocsIcon size={32} />}
          <h2 id="creation-title">{adding ? 'Add project' : 'New document'}</h2>
        </div>
        <p className="creation-description">
          {adding
            ? 'Give your project a name and choose its folder.'
            : 'Choose a name and where this document belongs.'}
        </p>
        {adding ? (
          <>
            <label className="field-label">
              Project name
              <input
                autoFocus
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="e.g. THEO 12"
                disabled={busy}
                required
              />
            </label>
            <span className="field-label">Project folder</span>
            <button type="button" className="folder-choice" onClick={() => void chooseFolder()} disabled={busy}>
              <FolderIcon />
              <span>{folder || 'Choose a folder…'}</span>
            </button>
            {snap.provider === 'opencode' ? (
              <p className="field-help">
                Projects use Git folders. For other folders, choose “Choose folder…” under Location.
              </p>
            ) : (
              <p className="field-help">Documents in this project can work with the files in this folder.</p>
            )}
          </>
        ) : (
          <>
            <label className="field-label">
              Document name
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Untitled document"
                disabled={busy}
              />
            </label>
            <label className="field-label">
              Location
              <select
                data-testid="new-doc-location"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                disabled={busy}
              >
                <option value="">My documents · No project</option>
                {folders.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
                <option value="folder">Choose folder…</option>
              </select>
            </label>
            {location === 'folder' ? (
              <button type="button" className="folder-choice" onClick={() => void chooseFolder()} disabled={busy}>
                <FolderIcon />
                <span>{folder || 'Choose a folder…'}</span>
              </button>
            ) : (
              <p className="field-help">
                {selected ? `Created in ${selected.name}.` : 'Saved with your documents, outside a project.'}
              </p>
            )}
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setAdding(true)
                setFolder('')
                setError('')
              }}
              disabled={busy}
            >
              + Add a project
            </button>
            {creation.template && creation.template.id !== 'blank' ? (
              <div className="template-summary">
                <span>Template</span>
                <strong>{creation.template.title}</strong>
                <small>A starter is placed in your document for you to finish.</small>
              </div>
            ) : null}
          </>
        )}
        {error ? (
          <p className="creation-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              if (adding && !creation.projectOnly) {
                setAdding(false)
                setError('')
              } else onClose()
            }}
          >
            {adding && !creation.projectOnly ? 'Back' : 'Cancel'}
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || (adding ? !projectName.trim() || !folder : location === 'folder' && !folder)}
          >
            {busy ? 'Creating…' : adding ? 'Add project' : 'Create document'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
