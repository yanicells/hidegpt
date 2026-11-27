/**
 * Find in document: text search over the page's DOM and painting with the CSS
 * Custom Highlight API. Ranges point into the existing text nodes, so a search
 * never changes the DOM: memoised rows stay memoised and nothing lays out again.
 * Rows skipped by `content-visibility: auto` keep their text nodes, so they are
 * searched like any other and painted when they scroll into view.
 */

/** Elements that end a run of text: a match never spans two of them, as in Docs. */
const PARAGRAPH = 'p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote, dt, dd, figcaption, summary, .doc-block'

/** Not page text: the writing line, controls, anything drawn only for looks, and a folded callout's body. */
const SKIP = '.composer-wrap, [aria-hidden="true"], [hidden], button, details:not([open]) > :not(summary)'

/**
 * Lower-cases `text` one character at a time, keeping any character whose
 * lower case has another length (İ), so offsets into the result are offsets
 * into `text`.
 */
function fold(text: string): string {
  let out = ''
  for (const char of text) {
    const lower = char.toLowerCase()
    out += lower.length === char.length ? lower : char
  }
  return out
}

type Run = { nodes: Text[]; starts: number[]; text: string }

/** The page's text nodes under `root`, grouped into runs by paragraph. */
function textRuns(root: Element): Run[] {
  const runs: Run[] = []
  let current: Run | null = null
  let owner: Element | null = null
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIP) || !node.nodeValue ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const paragraph = text.parentElement?.closest(PARAGRAPH) ?? root
    if (!current || paragraph !== owner) {
      current = { nodes: [], starts: [], text: '' }
      runs.push(current)
      owner = paragraph
    }
    current.nodes.push(text)
    current.starts.push(current.text.length)
    current.text += text.data
  }
  return runs
}

/** The text node and offset at `index` in `run`; an end index stays in the node it ends. */
function locate(run: Run, index: number, end: boolean): [Text, number] {
  let at = 0
  while (at + 1 < run.nodes.length && (end ? run.starts[at + 1]! < index : run.starts[at + 1]! <= index)) at++
  return [run.nodes[at]!, index - run.starts[at]!]
}

/** Every match of `query` under `root`, in document order. Case-insensitive unless `matchCase`. */
export function findRanges(root: Element, query: string, matchCase = false): Range[] {
  if (!query) return []
  const needle = matchCase ? query : fold(query)
  const ranges: Range[] = []
  for (const run of textRuns(root)) {
    const haystack = matchCase ? run.text : fold(run.text)
    for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
      const range = root.ownerDocument.createRange()
      range.setStart(...locate(run, index, false))
      range.setEnd(...locate(run, index + needle.length, true))
      ranges.push(range)
    }
  }
  return ranges
}

/** Highlight names, styled in find.css as `::highlight(...)`. */
export const MATCH_HIGHLIGHT = 'docs-find-match'
export const CURRENT_HIGHLIGHT = 'docs-find-current'

/** Paints `ranges`, with `current` on top in the darker green; an empty list clears both. */
export function paintMatches(ranges: readonly Range[], current: number): void {
  // Chromium has the registry; jsdom does not, and a page without it still counts and jumps.
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return
  if (ranges.length === 0) {
    CSS.highlights.delete(MATCH_HIGHLIGHT)
    CSS.highlights.delete(CURRENT_HIGHLIGHT)
    return
  }
  CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...ranges))
  const active = ranges[current]
  if (!active) {
    CSS.highlights.delete(CURRENT_HIGHLIGHT)
    return
  }
  const top = new Highlight(active)
  top.priority = 1
  CSS.highlights.set(CURRENT_HIGHLIGHT, top)
}
