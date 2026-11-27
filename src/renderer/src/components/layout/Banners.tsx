import { useState } from 'react'

import type { Snapshot } from '../../../../shared/model'
import { clearCommandError, dispatch, useCommandError } from '../../session-bridge'
import { MIcon } from '../ui/MaterialIcon'

// One lane of notices that never covers the page's controls, and a dismissal
// that clears the error itself. Adapted from T3 Code
// (apps/web/src/components/chat/ChatBannerLane.tsx, ThreadErrorBanner.tsx) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
const bannerKey = (snap: Snapshot, error: string) => `${snap.provider}\u0000${error}`

/**
 * A short, stable code for an error, so two failures can be told apart and
 * named without showing their text (which can name the library): FNV-1a over
 * the message, as eight hex digits. Main sends no report id with the message,
 * so this is a fingerprint of the sentence, not a key into the saved reports.
 */
export function errorCode(message: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < message.length; i++) {
    hash ^= message.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Docs' snackbars in the bottom-left corner: sign-in prompts and errors. They
 * float over the window, so showing or hiding one never moves the page, and
 * Home and the open document stay usable underneath.
 */
export function Banners({ snap }: { snap: Snapshot }) {
  const commandError = useCommandError()
  const libraryError = snap.error ?? (snap.status === 'error' ? 'Docs couldn’t open this library.' : null)
  const libraryKey = libraryError === null ? null : bannerKey(snap, libraryError)
  const [dismissed, setDismissed] = useState<string | null>(null)
  // A dismissal covers this occurrence only: once the library's error clears or changes, the same one shows again.
  if (dismissed !== null && dismissed !== libraryKey) setDismissed(null)
  const errors = [...new Set([libraryKey === dismissed ? null : libraryError, commandError])].filter(
    (error): error is string => error !== null,
  )
  // A command error just clears, so the same failure on a retry shows again.
  const dismiss = (error: string) => {
    if (error === commandError) clearCommandError()
    if (error === libraryError) setDismissed(libraryKey)
  }
  const ready = snap.status === 'ready'
  return (
    <div className="snackbar-lane">
      {ready && snap.requiresAuth && !snap.account && snap.capabilities.login ? (
        <div className="snackbar" role="status">
          <span className="snackbar-text" data-testid="auth-banner">
            Sign in to use Docs.
          </span>
          <button type="button" className="snackbar-action" onClick={() => dispatch({ op: 'login' })}>
            Sign in
          </button>
        </div>
      ) : null}
      {ready && snap.loginUrl ? (
        <div className="snackbar" role="status">
          <span className="snackbar-text" data-testid="login-url">
            Finish signing in in your browser.
          </span>
        </div>
      ) : null}
      {errors.map((error) => (
        <div key={error} className="snackbar" role="alert">
          {/* Docs' own wording; the message itself never reaches the window. */}
          <span className="snackbar-text" data-testid="error-banner">
            Something went wrong. Try again.
          </span>
          <ErrorDetails code={errorCode(error)} />
          <button
            type="button"
            className="snackbar-action"
            data-testid="error-refresh"
            onClick={() => {
              clearCommandError()
              void dispatch({ op: 'refresh' })
            }}
          >
            Retry
          </button>
          <button
            type="button"
            className="snackbar-close"
            data-testid="error-dismiss"
            aria-label="Dismiss"
            onClick={() => dismiss(error)}
          >
            <MIcon name="close" size={20} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** "Details" shows only the error's code; the saved reports are under Help → Report a problem…. */
function ErrorDetails({ code }: { code: string }) {
  const [open, setOpen] = useState(false)
  if (open) return <span className="error-details">Error {code}</span>
  return (
    <button type="button" className="snackbar-action error-details-toggle" onClick={() => setOpen(true)}>
      Details
    </button>
  )
}
