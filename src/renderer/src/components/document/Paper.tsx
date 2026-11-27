import { useRef, type ReactNode } from 'react'

import { PAGE_HEIGHT, PAGE_PITCH, usePages } from './pages'

/**
 * The paper in print layout: the sheets are drawn behind one flow of text that
 * `usePages` breaks between them. The page count is state here, not on the
 * document, so a new page re-renders the sheets and leaves the rows, which
 * arrive as `children`, alone.
 */
export function Paper({ children }: { children: ReactNode }) {
  const paperRef = useRef<HTMLElement>(null)
  const pages = usePages(paperRef)
  return (
    <article className="paper" ref={paperRef} style={{ minHeight: (pages - 1) * PAGE_PITCH + PAGE_HEIGHT }}>
      <div className="page-sheets" aria-hidden="true">
        {Array.from({ length: pages }, (_, index) => (
          <div key={index} className="page-sheet" style={{ top: index * PAGE_PITCH }} />
        ))}
      </div>
      {children}
    </article>
  )
}
