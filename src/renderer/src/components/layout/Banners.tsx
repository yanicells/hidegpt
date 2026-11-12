import { useState } from 'react'

import type { Snapshot } from '../../../../shared/model'
import { clearCommandError, dispatch, useCommandError } from '../../session-bridge'

// Dismissal is remembered per library and message, so the same error stays
// hidden while a new one still shows. Adapted from T3 Code
// (apps/web/src/components/chat/ThreadErrorBanner.tsx) at commit 8a14762c.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
const bannerKey = (snap: Snapshot, error: string) => `${snap.provider}\u0000${error}`

/**
 * The strip under the header: sign-in prompts and errors. Errors never
 * replace the page; Home and the open document stay usable underneath.
 */
export function Banners({ snap }: { snap: Snapshot }) {
  const commandError = useCommandError()
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const libraryError = snap.error ?? (snap.status === 'error' ? 'Docs couldn’t open this library.' : null)
  const errors = [...new Set([libraryError, commandError])].filter(
    (error): error is string => Boolean(error) && !dismissed.has(bannerKey(snap, error ?? '')),
  )
  // A command error just clears, so the same failure on a retry shows again.
  const dismiss = (error: string) => {
    if (error === commandError) clearCommandError()
    if (error === libraryError) setDismissed((current) => new Set(current).add(bannerKey(snap, error)))
  }
  const ready = snap.status === 'ready'
  return (
    <div className="banners">
      {ready && snap.requiresAuth && !snap.account && snap.capabilities.login ? (
        <div className="banner" role="status">
          <span data-testid="auth-banner">Sign in to use Docs.</span>
          <button type="button" onClick={() => dispatch({ op: 'login' })}>
            Sign in
          </button>
        </div>
      ) : null}
      {ready && snap.loginUrl ? (
        <div className="banner" role="status">
          <span data-testid="login-url">Finish signing in in your browser.</span>
        </div>
      ) : null}
      {errors.map((error) => (
        <div key={error} className="banner danger" role="alert">
          {/* Docs' own wording; the raw message can name the provider, so it waits behind Details. */}
          <span data-testid="error-banner">Something went wrong. Try again.</span>
          <ErrorDetails message={error} />
          <button
            type="button"
            data-testid="error-refresh"
            onClick={() => {
              clearCommandError()
              setDismissed(new Set())
              void dispatch({ op: 'refresh' })
            }}
          >
            Refresh
          </button>
          <button type="button" data-testid="error-dismiss" onClick={() => dismiss(error)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Raw errors can name the provider or model, so they wait behind a click,
 * the same way names wait inside menus.
 */
function ErrorDetails({ message }: { message: string }) {
  const [open, setOpen] = useState(false)
  if (open) return <span className="error-details">{message}</span>
  return (
    <button type="button" className="error-details-toggle" onClick={() => setOpen(true)}>
      Details
    </button>
  )
}
