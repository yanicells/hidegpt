import { useState } from 'react'

import { formatListDate } from '../../../../shared/labels'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '../ui/dialog'
import { MIcon } from '../ui/MaterialIcon'
import type { Folder } from './projects'

const UNTITLED = 'Untitled folder'

const PICKER_TABS = ['Recent', 'My Drive', 'Shared with me', 'Starred'] as const
type PickerTab = (typeof PICKER_TABS)[number]

/**
 * The folder icon beside "AZ" on Docs home opens Drive's file picker. Here it
 * browses project folders; "New folder" adds a project from a local directory.
 */
export function FolderPicker({
  folders,
  onOpen,
  onClose,
}: {
  folders: Folder[]
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState(UNTITLED)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<PickerTab>('My Drive')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  // Projects are the only "files" here: shared and starred stay empty, like a fresh Drive.
  const needle = query.trim().toLowerCase()
  const matching = folders.filter((folder) => !needle || folder.name.toLowerCase().includes(needle))
  const shown =
    tab === 'My Drive'
      ? matching
      : tab === 'Recent'
        ? matching.filter((folder) => folder.updatedAt).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        : []

  // Drive's dialog asks only for a name; Create then asks the system where the folder lives.
  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const path = await window.hidegpt.pickDirectory()
      if (!path) return
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
                // Drive pre-fills the name and selects it, so typing replaces it.
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            </label>
            {error ? (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button type="button" className="text-button" disabled={busy} onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="submit" className="text-button" disabled={busy || !name.trim()}>
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
            <div className="picker-cols" aria-hidden="true">
              <span className="picker-name">Name</span>
              <span className="picker-owner">Owner</span>
              <span className="picker-date">Last modified</span>
            </div>
            <ul className="picker-list" aria-label="Folders">
              {shown.map((folder) => (
                <li key={folder.id}>
                  {/* Like Google Picker: a click selects, a double-click (or Select) opens. */}
                  <button
                    type="button"
                    className="picker-row"
                    data-testid={`picker-${folder.id}`}
                    aria-pressed={selected === folder.id}
                    onClick={() => setSelected(folder.id)}
                    onDoubleClick={() => onOpen(folder.id)}
                  >
                    <MIcon name="folder_fill" size={24} />
                    <span className="picker-name">{folder.name}</span>
                    <span className="picker-owner">me</span>
                    <span className="picker-date">{formatListDate(folder.updatedAt) || '—'}</span>
                  </button>
                </li>
              ))}
              {shown.length === 0 ? <li className="picker-empty">{query ? 'No results' : 'No files here'}</li> : null}
            </ul>
            <div className="picker-foot">
              <button type="button" className="outlined-button" data-testid="new-folder" onClick={() => {
                  setName(UNTITLED)
                  setCreating(true)
                }}>
                <MIcon name="add" />
                New folder
              </button>
              <DialogClose className="text-button">Cancel</DialogClose>
              <button
                type="button"
                className="filled-button"
                data-testid="picker-select"
                disabled={!selected || !shown.some((folder) => folder.id === selected)}
                onClick={() => selected && onOpen(selected)}
              >
                Select
              </button>
            </div>
          </>
        )}
      </DialogPopup>
    </Dialog>
  )
}
