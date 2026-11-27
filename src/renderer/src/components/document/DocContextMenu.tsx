// The edit-flags logic (which rows apply to the right-clicked target) is adapted from
// T3 Code (apps/desktop/src/window/DesktopWindow.ts, the context-menu handler, and
// apps/web/src/contextMenuFallback.ts) at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License.

import { lazy, Suspense, useEffect, useState, type RefObject } from 'react'

// The rows and the menu load on the first right click, keeping them out of the entry chunk.
const DocContextPopup = lazy(() => import('./DocContextPopup').then((module) => ({ default: module.DocContextPopup })))

/** What the right click landed on, read when the menu opens. */
export type Target = {
  x: number
  y: number
  /** The selected text, in the page or in the writing line. */
  text: string
  /** The writing line and its selection, when the click was in it: the one place Cut and Delete apply. */
  field: { element: HTMLTextAreaElement | HTMLInputElement; start: number; end: number } | null
  /** The word Define would look up, if any. */
  word: string | null
  /** The writing line, where "Help me write" goes; absent while a long document still opens. */
  composer: HTMLTextAreaElement | null
}

const WORD = /^[\p{L}\p{N}][\p{L}\p{N}'’-]*$/u
const WORD_CHAR = /[\p{L}\p{N}'’-]/u
const MAX_WORD = 40

/** The word around a point in the page text, the way Docs' caret picks it for Define. */
function wordAt(x: number, y: number): string | null {
  const position = document.caretPositionFromPoint?.(x, y)
  const node = position?.offsetNode
  if (!position || node?.nodeType !== Node.TEXT_NODE) return null
  const text = node.textContent ?? ''
  let start = position.offset
  let end = position.offset
  while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--
  while (end < text.length && WORD_CHAR.test(text[end]!)) end++
  const word = text.slice(start, end)
  return WORD.test(word) && word.length <= MAX_WORD ? word : null
}

/** Reads the target of a right click inside `page`. */
function readTarget(event: MouseEvent, page: HTMLElement): Target {
  const composer = page.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')
  const element = event.target instanceof Element ? event.target : null
  const field = element?.closest<HTMLTextAreaElement | HTMLInputElement>('textarea, input') ?? null
  if (field) {
    const start = field.selectionStart ?? 0
    const end = field.selectionEnd ?? start
    return {
      x: event.clientX,
      y: event.clientY,
      text: field.value.slice(start, end),
      field: { element: field, start, end },
      word: null,
      composer,
    }
  }
  const selection = document.getSelection()
  const inPage = selection?.anchorNode ? page.contains(selection.anchorNode) : false
  const text = inPage ? (selection?.toString() ?? '') : ''
  const trimmed = text.trim()
  const word =
    trimmed && WORD.test(trimmed) && trimmed.length <= MAX_WORD ? trimmed : wordAt(event.clientX, event.clientY)
  return { x: event.clientX, y: event.clientY, text, field: null, word, composer }
}

/**
 * Docs' right-click menu over the page (DocContextPopup), opened at the
 * pointer in place of Chromium's own. Mount once per document with the page
 * element.
 */
export function DocContextMenu({ pageRef }: { pageRef: RefObject<HTMLElement | null> }) {
  const [target, setTarget] = useState<Target | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const page = pageRef.current
    if (!page) return
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      setTarget(readTarget(event, page))
      setOpen(true)
    }
    page.addEventListener('contextmenu', onContextMenu)
    return () => page.removeEventListener('contextmenu', onContextMenu)
  }, [pageRef])

  if (!target) return null
  return (
    <Suspense fallback={null}>
      <DocContextPopup target={target} open={open} onOpenChange={setOpen} />
    </Suspense>
  )
}
