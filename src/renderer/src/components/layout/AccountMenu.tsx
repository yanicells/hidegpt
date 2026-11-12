import { useState } from 'react'

import { accountAddress, accountLabel, avatarLetter, libraryName, PROVIDERS } from '../../../../shared/labels'
import type { ProviderId, Snapshot } from '../../../../shared/model'
import { dispatch, request } from '../../session-bridge'
import { MIcon, type MaterialIconName } from '../ui/MaterialIcon'
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from '../ui/popover'
import { capitalize } from '../ui/text'
import { Tip } from '../ui/tooltip'

const LIBRARY_COLORS: Record<ProviderId, string> = { codex: '#0b8043', opencode: '#e8710a', claude: '#c5221f' }

/**
 * Google's account switcher behind the avatar. Each "account" is a document
 * library (provider), named like a Chrome profile (Personal, Work, School);
 * switching swaps the whole library. Only a real address is ever shown.
 */
export function AccountMenu({ snap }: { snap: Snapshot }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<ProviderId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const label = accountLabel(snap.account)
  const email = accountAddress(snap.account)
  const name = email ? email.split('@')[0] : null

  const switchTo = async (next: ProviderId) => {
    if (next === snap.provider || pending) return
    setPending(next)
    setError(null)
    const result = await request({ op: 'setProvider', provider: next, home: snap.route.kind === 'home' })
    setPending(null)
    if (result.ok) setOpen(false)
    else setError('Couldn’t switch accounts. Try again.')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label={email ? `Google Account\n${email}` : 'Google Account'}>
        <PopoverTrigger className="avatar" data-testid="menu-account" aria-label={`Google Account: ${label}`}>
          <span>{avatarLetter(snap.account)}</span>
        </PopoverTrigger>
      </Tip>
      <PopoverPopup className="account-panel" data-testid="panel-account" aria-label="Google Account">
        <div className="account-card">
          <span className="account-email">{snap.account ? label : 'Not signed in'}</span>
          <PopoverClose className="account-close" aria-label="Close">
            <MIcon name="close" size={24} />
          </PopoverClose>
          <span className="account-photo">
            <span className="avatar-lg">{avatarLetter(snap.account)}</span>
            {/* Google's "Change profile picture" badge; costume, like Manage. */}
            <span className="account-camera" aria-hidden="true">
              <MIcon name="photo_camera" size={18} />
            </span>
          </span>
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
                {libraryName(provider).charAt(0)}
              </span>
              <span className="account-row-text">
                {libraryName(provider)}
                {pending === provider ? (
                  <small>Switching…</small>
                ) : snap.provider === provider && email ? (
                  <small>{email}</small>
                ) : null}
              </span>
              {snap.provider === provider ? (
                <span className="row-icon ml-auto">
                  <MIcon name="check" />
                </span>
              ) : null}
            </button>
          ))}
          {/* Only libraries that sign in from Docs use these rows; the others reuse their CLI's login. */}
          <AccountAction
            testId={snap.capabilities.login && !snap.account ? 'action-login' : undefined}
            icon="person_add"
            label="Add another account"
            run={
              snap.capabilities.login && !snap.account
                ? () => {
                    void dispatch({ op: 'login' })
                    setOpen(false)
                  }
                : undefined
            }
          />
          {snap.capabilities.login && snap.account ? (
            <AccountAction
              testId="action-logout"
              icon="logout"
              label="Sign out"
              run={() => {
                void dispatch({ op: 'logout' })
                setOpen(false)
              }}
            />
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

/** A Google account-switcher action row ("Add another account", "Sign out"). */
function AccountAction({
  testId,
  icon,
  label,
  run,
}: {
  testId?: string
  icon: MaterialIconName
  label: string
  run?: () => void
}) {
  return (
    <button type="button" className="account-row" data-testid={testId} onClick={run}>
      <span className="row-icon">
        <MIcon name={icon} />
      </span>
      <span className="account-row-text">{label}</span>
    </button>
  )
}
