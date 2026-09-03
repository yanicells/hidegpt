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
          <span data-testid="error-banner">{snap.error}</span>
        </div>
      ) : null}
    </div>
  )
}
