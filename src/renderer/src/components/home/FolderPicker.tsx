import { useState } from 'react'

import type { Snapshot } from '../../../../codex/types'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '../ui/dialog'
import { MIcon } from '../ui/MaterialIcon'
import type { Folder } from './LocationMenu'

const PICKER_TABS = ['Recent', 'My Drive', 'Shared with me', 'Starred'] as const
type PickerTab = (typeof PICKER_TABS)[number]

/**
 * The folder icon beside "AZ" on Docs home opens Drive's file picker. Here it
 * browses project folders; "New folder" adds a project from a local directory.
 */
export function FolderPicker({
  snap,
  folders,
  onOpen,
  onClose,
}: {
  snap: Snapshot
  folders: Folder[]
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<PickerTab>('My Drive')
  const [query, setQuery] = useState('')
  // Projects are the only "files" here: shared and starred stay empty, like a fresh Drive.
  const needle = query.trim().toLowerCase()
  const shown =
    tab === 'Recent' || tab === 'My Drive'
      ? folders.filter((folder) => !needle || folder.name.toLowerCase().includes(needle))
      : []

  const choose = async () => {
    try {
      const picked = await window.hidegpt.pickDirectory()
      if (picked) {
        setPath(picked)
        if (!name) setName(picked.split('/').pop() ?? '')
      }
    } catch (cause) {
      setError(String(cause))
    }
  }

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      await window.hidegpt.dispatch({ op: 'createProject', name: name.trim(), cwd: path })
      const project = window.hidegpt.getSnapshot().projects.find((item) => item.roots.some((root) => root.path === path))
      if (!project) throw new Error('The folder could not be found. Refresh and try again.')
      onOpen(project.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogPopup className={creating ? 'small' : 'picker'}>
        {creating ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <DialogTitle render={<h2 />}>New folder</DialogTitle>
            <label className="outlined-field">
              <input
                autoFocus
                aria-label="Folder name"
                value={name}
                placeholder="Untitled folder"
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            </label>
            <button type="button" className="folder-path" onClick={() => void choose()} disabled={busy}>
              <MIcon name="folder_open" />
              <span>{path || 'Choose a location on this computer…'}</span>
            </button>
            {snap.provider === 'opencode' ? <p className="field-help">Folders must be Git repositories.</p> : null}
            {error ? (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button type="button" className="text-button" disabled={busy} onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="submit" className="text-button" disabled={busy || !name.trim() || !path}>
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="picker-head">
              <DialogTitle render={<h2 />}>Open a file</DialogTitle>
              <DialogClose className="icon-btn" aria-label="Close">
                <MIcon name="close" size={24} />
              </DialogClose>
            </div>
            <label className="picker-search">
              <MIcon name="search" />
              <input
                type="search"
                aria-label="Search in Drive"
                placeholder="Search in Drive or paste URL"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="picker-tabs" role="tablist">
              {PICKER_TABS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={tab === item}
                  className={tab === item ? 'active' : undefined}
                  onClick={() => setTab(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <ul className="picker-list" aria-label="Folders">
              {shown.map((folder) => (
                <li key={folder.id}>
                  <button type="button" className="picker-row" data-testid={`picker-${folder.id}`} onClick={() => onOpen(folder.id)}>
                    <MIcon name="folder" size={24} />
                    <span className="picker-name">{folder.name}</span>
                    <span className="picker-meta">
                      {folder.count} {folder.count === 1 ? 'file' : 'files'}
                    </span>
                  </button>
                </li>
              ))}
              {shown.length === 0 ? <li className="picker-empty">{query ? 'No results' : 'No files here'}</li> : null}
            </ul>
            <div className="picker-foot">
              <button type="button" className="outlined-button" data-testid="new-folder" onClick={() => setCreating(true)}>
                <MIcon name="add" />
                New folder
              </button>
            </div>
          </>
        )}
      </DialogPopup>
    </Dialog>
  )
}
