import { useEffect, useRef, useState } from 'react'

import type { Snapshot } from '../../../../shared/model'
import { dispatch } from '../../session-bridge'
import { AccountMenu } from '../layout/AccountMenu'
import { DocsIcon } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'

export function HomeHeader({ snap }: { snap: Snapshot }) {
  const [query, setQuery] = useState(snap.search)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        void dispatch({ op: 'applySearch' })
      }
    },
    [],
  )
  return (
    <header className="home-header">
      <div className="brand">
        <span className="header-icon" aria-hidden="true">
          <MIcon name="menu" size={24} />
        </span>
        <DocsIcon size={40} />
        <span className="brand-name">Docs</span>
      </div>
      <label className="search">
        <MIcon name="search" size={24} />
        <input
          data-testid="home-search"
          type="search"
          value={query}
          placeholder="Search"
          aria-label="Search documents"
          onChange={(event) => {
            setQuery(event.target.value)
            void dispatch({ op: 'setSearch', value: event.target.value })
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              timer.current = null
              void dispatch({ op: 'applySearch' })
            }, 300)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              if (timer.current) {
                clearTimeout(timer.current)
                timer.current = null
              }
              void dispatch({ op: 'applySearch' })
            }
          }}
        />
      </label>
      <div className="header-end">
        <span className="header-icon" aria-hidden="true">
          <MIcon name="apps" size={24} />
        </span>
        <AccountMenu snap={snap} />
      </div>
    </header>
  )
}
