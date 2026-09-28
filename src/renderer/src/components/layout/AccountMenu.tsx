import { useRef, useState } from 'react'

import { accountLabel, avatarLetter, providerLabel } from '../../../../codex/labels'
import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { MenuPanel, useDismiss, type Item } from '../ui/MenuPanel'

export function AccountMenu({ snap }: { snap: Snapshot }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  const items: Item[] =
    snap.provider !== 'codex'
      ? []
      : snap.account
        ? [{ id: 'logout', label: 'Log out', run: () => dispatch({ op: 'logout' }) }]
        : [{ id: 'login', label: 'Log in with ChatGPT', run: () => dispatch({ op: 'login' }) }]
  const caption = snap.provider === 'codex' ? null : `${providerLabel(snap.provider)} session`
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
