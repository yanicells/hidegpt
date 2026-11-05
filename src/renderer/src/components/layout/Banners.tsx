import { useState } from 'react'

import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'

export function Banners({ snap }: { snap: Snapshot }) {
  if (snap.status !== 'ready') return null
  return (
    <div className="banners">
      {snap.requiresAuth && !snap.account ? (
        <div className="banner" role="status">
          <span data-testid="auth-banner">Sign in to use Docs.</span>
          <button type="button" onClick={() => dispatch({ op: 'login' })}>
            Sign in
          </button>
        </div>
      ) : null}
      {snap.loginUrl ? (
        <div className="banner" role="status">
          <span data-testid="login-url">Finish signing in in your browser.</span>
        </div>
      ) : null}
      {snap.error ? (
        <div className="banner danger" role="alert">
          <span data-testid="error-banner">Something went wrong. Try again.</span>
          <ErrorDetails message={snap.error} />
        </div>
      ) : null}
    </div>
  )
}

/** The whole window when the session can't start: Docs' "Unable to load file" with Reload. */
export function LoadError({ message }: { message: string | null }) {
  return (
    <div className="status" data-testid="status" role="alert">
      <div>
        <p>Unable to load file.</p>
        <button type="button" className="status-reload" onClick={() => dispatch({ op: 'refresh' })}>
          Reload
        </button>
        {message ? <ErrorDetails message={message} /> : null}
      </div>
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
