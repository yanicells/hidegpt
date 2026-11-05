import { useState } from 'react'

import { accountLabel, avatarLetter, PROVIDERS, providerLabel } from '../../../../codex/labels'
import type { Provider, Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { MIcon } from '../ui/MaterialIcon'
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from '../ui/popover'

const LIBRARY_COLORS: Record<Provider, string> = { codex: '#0b8043', opencode: '#e8710a', claude: '#c5221f' }

/**
 * Google's account switcher behind the avatar. Each "account" is a document
 * library (provider); switching swaps the whole library. Names only appear
 * once the menu is open.
 */
export function AccountMenu({ snap }: { snap: Snapshot }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<Provider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const label = accountLabel(snap.account)
  const name = snap.account ? label.split('@')[0] : null

  const switchTo = async (next: Provider) => {
    if (next === snap.provider || pending) return
    setPending(next)
    setError(null)
    try {
      await window.hidegpt.dispatch({ op: 'setProvider', provider: next, home: snap.route.kind === 'home' })
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t switch accounts. Try again.')
    } finally {
      setPending(null)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="avatar"
        data-testid="menu-account"
        aria-label={`Google Account: ${label}`}
        title={`Google Account\n${label}`}
      >
        <span>{avatarLetter(snap.account)}</span>
      </PopoverTrigger>
      <PopoverPopup className="account-panel" data-testid="panel-account" aria-label="Google Account">
          <div className="account-card">
            <span className="account-email">{snap.account ? label : 'Not signed in'}</span>
            <span className="avatar-lg">{avatarLetter(snap.account)}</span>
            <span className="account-hello">{name ? `Hi, ${capitalize(name)}!` : 'Hi there!'}</span>
            <PopoverClose className="account-manage">Manage your Google Account</PopoverClose>
          </div>
          <div className="account-list" role="group" aria-label="Switch account">
            {PROVIDERS.map((provider) => (
              <button
                key={provider}
                type="button"
                className="account-row"
                aria-pressed={snap.provider === provider}
                data-testid={`library-${provider}`}
                disabled={Boolean(pending)}
                onClick={() => void switchTo(provider)}
              >
                <span className="avatar-sm" style={{ background: LIBRARY_COLORS[provider] }}>
                  {providerLabel(provider).charAt(0)}
                </span>
                <span className="account-row-text">
                  {providerLabel(provider)}
                  <small>
                    {pending === provider
                      ? 'Switching…'
                      : snap.provider === provider
                        ? snap.account
                          ? label
                          : 'Signed in'
                        : 'Switch account'}
                  </small>
                </span>
                {snap.provider === provider ? (
                  <span className="row-icon ml-auto">
                    <MIcon name="check" />
                  </span>
                ) : null}
              </button>
            ))}
            {snap.provider === 'codex' ? (
              <button
                type="button"
                className="account-row"
                data-testid={snap.account ? 'action-logout' : 'action-login'}
                onClick={() => {
                  dispatch({ op: snap.account ? 'logout' : 'login' })
                  setOpen(false)
                }}
              >
                <span className="row-icon">
                  <MIcon name={snap.account ? 'logout' : 'person_add'} />
                </span>
                <span className="account-row-text">{snap.account ? 'Sign out' : 'Add another account'}</span>
              </button>
            ) : null}
          </div>
          {error ? (
            <p className="account-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="account-foot">
            <span>Privacy Policy</span>
            <span aria-hidden="true">•</span>
            <span>Terms of Service</span>
          </div>
      </PopoverPopup>
      {pending ? <div className="top-progress" role="progressbar" aria-label="Loading" /> : null}
    </Popover>
  )
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}
