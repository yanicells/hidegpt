// Adapted from T3 Code (apps/web/src/components/chat/markdownStreamBlocks.ts) at commit 8a14762c.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

// Definitions (also inside quotes and list items), footnotes, raw HTML, container directives and
// display math can tie blocks together. Checked outside code fences, where `<div>` or a regex
// like `[^a-z]` is just code.
const DOCUMENT_WIDE_SYNTAX =
  /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)]))*[ \t]*\[[^\]\n]+\]:|^ {0,3}(?:<[A-Za-z!?/]|:::|\$\$)|\[\^/m
// A backtick fence's info string can't contain a backtick (```a`b is inline code).
const FENCE_PATTERN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
// CommonMark's blank line: spaces and tabs only, so a no-break space is text.
const BLANK_LINE = /^[ \t]*$/
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/

/**
 * Cuts Markdown at blank lines that close every open block, so each piece
 * renders exactly as it would inside the whole text, and a streaming answer
 * re-parses only its last piece. Returns null when the text uses syntax that
 * spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  if (text.includes('\r')) return null
  const blocks: string[] = []
  let blockStart = 0
  let lineStart = 0
  let fence: string | null = null
  let fenceIndent = 0
  let afterBlankLine = false
  for (const line of text.split('\n')) {
    const opener = FENCE_PATTERN.exec(line)?.[1]
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked;
      // the rest stays one block, so it must not use document-wide syntax either.
      if (/\S/.test(line.slice(0, fenceIndent))) {
        if (DOCUMENT_WIDE_SYNTAX.test(text.slice(lineStart))) return null
        break
      }
      const closer = CLOSING_FENCE.exec(line)?.[1]
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) fence = null
      // An indented fence may have ended with its list item already (a closer read as an
      // opener), so its lines are still checked; only a top-level fence is surely code.
      else if (fenceIndent > 0 && DOCUMENT_WIDE_SYNTAX.test(line)) return null
    } else if (BLANK_LINE.test(line)) {
      afterBlankLine = true
    } else {
      if (DOCUMENT_WIDE_SYNTAX.test(line)) return null
      if (afterBlankLine && lineStart > blockStart && !CONTINUATION_PATTERN.test(line)) {
        blocks.push(text.slice(blockStart, lineStart))
        blockStart = lineStart
      }
      afterBlankLine = false
      fence = opener ?? null
      if (opener) fenceIndent = line.indexOf(opener)
    }
    lineStart += line.length + 1
  }
  blocks.push(text.slice(blockStart))
  return blocks
}
