import type { Snapshot } from '../../../../shared/model'
import { dispatch } from '../../session-bridge'
import { setPendingDraft, type Template } from '../../templates'
import { projectFolders } from './projects'

/**
 * Like Docs' "Blank document": creates "Untitled document" right away, inside
 * the folder (project) the home filter is showing. Templates seed the composer.
 * Failures surface through the snapshot's error banner.
 */
export async function createDocument(snap: Snapshot, projectId?: string, template?: Template): Promise<void> {
  const folder = projectId ? projectFolders(snap).find((item) => item.id === projectId) : undefined
  setPendingDraft(template?.prompt ?? '')
  // IPC keeps an `undefined` cwd as a key, which the command schema rejects; leave it out instead.
  const result = await dispatch({ op: 'newDocument', projectId: folder?.id ?? null, ...(folder ? { cwd: folder.cwd } : {}) })
  if (!result.ok) setPendingDraft('')
}
