import { useRef, useState } from 'react'

import { accountLabel, avatarLetter, providerLabel } from '../../../../shared/labels'
import type { Snapshot } from '../../../../shared/model'
import { dispatch } from '../../session-bridge'
import { MenuPanel, useDismiss, type Item } from '../ui/MenuPanel'

export function AccountMenu({ snap }: { snap: Snapshot }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  // `snap.account` is always the active library's own account. Libraries that
  // sign in outside Docs get a caption instead of Log in / Log out.
  const items: Item[] = !snap.capabilities.login
    ? []
    : snap.account
      ? [{ id: 'logout', label: 'Log out', run: () => dispatch({ op: 'logout' }) }]
      : [{ id: 'login', label: 'Log in with ChatGPT', run: () => dispatch({ op: 'login' }) }]
  const caption = snap.capabilities.login ? null : `${providerLabel(snap.provider)} session`
  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="avatar"
        data-testid="menu-account"
        aria-label={accountLabel(snap.account)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={accountLabel(snap.account)}
        onClick={() => setOpen((value) => !value)}
      >
        {avatarLetter(snap.account)}
      </button>
      {open ? (
        <MenuPanel testId="panel-account" align="end" items={items} onClose={() => setOpen(false)}>
          {caption ? (
            <div className="menu-caption">{caption}</div>
          ) : snap.account ? (
            <div className="menu-caption">{accountLabel(snap.account)}</div>
          ) : null}
        </MenuPanel>
      ) : null}
    </div>
  )
}
