import { useEffect, useState } from 'react'

type MarkdownModule = typeof import('./Markdown')

let loaded: MarkdownModule | null = null
let loading: Promise<MarkdownModule> | null = null

/**
 * Loads the Markdown renderer (unified, remark, GFM) once. It is a separate
 * chunk because Home never needs it; main.tsx starts it after the first paint.
 */
export function loadMarkdown(): Promise<MarkdownModule> {
  loading ??= import('./Markdown').then((module) => (loaded = module))
  return loading
}

/** The Markdown module, or null until it has loaded. */
export function useMarkdown(): MarkdownModule | null {
  const [module, setModule] = useState(loaded)
  useEffect(() => {
    if (!module) void loadMarkdown().then(setModule)
  }, [module])
  return module
}
