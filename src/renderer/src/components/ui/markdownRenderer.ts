// Adapted from T3 Code (apps/web/src/components/chat/markdownRenderer.ts) at commit 8a14762c.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { Element, Nodes, Root } from 'hast'
import { toJsxRuntime, type Components } from 'hast-util-to-jsx-runtime'
import { urlAttributes } from 'html-url-attributes'
import type { ReactElement } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified, type PluggableList } from 'unified'
import { VFile } from 'vfile'

export type MarkdownUrlTransform = (url: string, key: string, node: Element) => string

interface MarkdownRendererOptions {
  readonly remarkPlugins: PluggableList
  readonly components: Partial<Components>
  readonly urlTransform: MarkdownUrlTransform
}

// Elements are immutable, so a remount (reopening a document, "Load earlier")
// reuses one instead of parsing again. Parsing is most of the cost of rendering
// Markdown. An element and the tree it keeps hold about 20 bytes per source
// character, so this is about 10 MB.
const MAX_CACHED_CHARS = 500_000
const rendered = new Map<string, ReactElement>()
let cachedChars = 0
let nextRendererId = 0

// A short block still holds a whole element tree.
const ENTRY_OVERHEAD_CHARS = 200
const entrySize = (key: string) => key.length + ENTRY_OVERHEAD_CHARS

function remember(key: string, element: ReactElement) {
  // One huge answer would otherwise evict everything else.
  if (entrySize(key) > MAX_CACHED_CHARS / 4) return
  rendered.set(key, element)
  cachedChars += entrySize(key)
  for (const oldest of rendered.keys()) {
    if (cachedChars <= MAX_CACHED_CHARS) break
    rendered.delete(oldest)
    cachedChars -= entrySize(oldest)
  }
}

/**
 * Renders Markdown as react-markdown does, with one frozen processor instead
 * of a new one per render. `cache` keeps the element for text that will not
 * change again.
 */
export function createMarkdownRenderer({ remarkPlugins, components, urlTransform }: MarkdownRendererOptions) {
  const processor = unified().use(remarkParse).use(remarkPlugins).use(remarkRehype, { allowDangerousHtml: true }).freeze()
  const keyPrefix = `${nextRendererId++}\u0000`

  // Raw HTML becomes literal text, and URL attributes pass the transform, as react-markdown does.
  const prepare = (node: Nodes) => {
    if (!('children' in node)) return
    const { children } = node
    for (let index = 0; index < children.length; index++) {
      const child = children[index]
      if (child.type === 'raw') {
        children[index] = { type: 'text', value: child.value }
        continue
      }
      if (child.type !== 'element') continue
      const { properties } = child
      for (const key in properties) {
        if (!Object.hasOwn(urlAttributes, key)) continue
        const tags = urlAttributes[key]
        if (tags === null || tags?.includes(child.tagName)) {
          properties[key] = urlTransform(String(properties[key] || ''), key, child)
        }
      }
      prepare(child)
    }
  }

  return (text: string, cache: boolean): ReactElement => {
    const key = keyPrefix + text
    const cached = rendered.get(key)
    if (cached !== undefined) {
      // Refresh its place in the eviction order.
      rendered.delete(key)
      rendered.set(key, cached)
      return cached
    }
    const file = new VFile(text)
    const tree = processor.runSync(processor.parse(file), file) as Root
    prepare(tree)
    const element = toJsxRuntime(tree, {
      Fragment,
      components,
      ignoreInvalidStyle: true,
      jsx,
      jsxs,
      passKeys: true,
      passNode: true,
    })
    if (cache) remember(key, element)
    return element
  }
}
