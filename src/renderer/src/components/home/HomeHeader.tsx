import { useEffect, useRef, useState } from 'react'

import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { AccountMenu } from '../layout/AccountMenu'
import { DocsIcon, SearchIcon } from '../ui/Icons'

export function HomeHeader({ snap }: { snap: Snapshot }) {
  const [query, setQuery] = useState(snap.search)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        dispatch({ op: 'applySearch' })
      }
    },
    [],
  )
  return (
    <header className="home-header">
      <div className="brand">
        <DocsIcon size={40} />
        <span className="brand-name">Docs</span>
      </div>
      <label className="search">
        <SearchIcon />
        <input
          data-testid="home-search"
          type="search"
          value={query}
          placeholder="Search documents"
          aria-label="Search documents"
          onChange={(event) => {
            setQuery(event.target.value)
            dispatch({ op: 'setSearch', value: event.target.value })
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              timer.current = null
              dispatch({ op: 'applySearch' })
            }, 300)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              if (timer.current) {
                clearTimeout(timer.current)
                timer.current = null
              }
              dispatch({ op: 'applySearch' })
            }
          }}
        />
      </label>
      <div className="header-end">
        <AccountMenu snap={snap} />
      </div>
    </header>
  )
}
