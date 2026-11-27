import { useEffect, useRef, useState } from 'react'

import type { Snapshot } from '../../../../shared/model'
import { dispatch } from '../../session-bridge'
import { AccountMenu } from '../layout/AccountMenu'
import { DocsIcon, ProductIcon, type Product } from '../ui/Icons'
import { MIcon } from '../ui/MaterialIcon'
import { Tip } from '../ui/tooltip'

/** Docs' quick-launch pill: the sibling products, opened in the browser (main's window-open handler). */
const PRODUCTS: readonly { product: Product; label: string; url: string }[] = [
  { product: 'sheets', label: 'Sheets', url: 'https://docs.google.com/spreadsheets/' },
  { product: 'slides', label: 'Slides', url: 'https://docs.google.com/presentation/' },
  { product: 'vids', label: 'Vids', url: 'https://docs.google.com/videos/' },
  { product: 'forms', label: 'Forms', url: 'https://docs.google.com/forms/' },
]

/** Home's top bar: menu, logo and wordmark, document search, the quick-launch pill, apps and account. */
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
        <DocsIcon height={37} width={27} />
        <span className="brand-name">Docs</span>
      </div>
      <label className="search">
        <MIcon name="search" size={24} />
        <input
          className="cut-text"
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
        <nav className="quick-launch" aria-label="Quick launch">
          {PRODUCTS.map(({ product, label, url }) => (
            <Tip key={product} label={label}>
              <a href={url} target="_blank" rel="noreferrer" aria-label={label}>
                <ProductIcon product={product} />
              </a>
            </Tip>
          ))}
        </nav>
        <span className="header-icon" aria-hidden="true">
          <MIcon name="apps" size={24} />
        </span>
        <AccountMenu snap={snap} />
      </div>
    </header>
  )
}
