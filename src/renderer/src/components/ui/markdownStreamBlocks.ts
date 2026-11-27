// Adapted from T3 Code (apps/web/src/components/chat/markdownStreamBlocks.ts) at commit 8a14762c,
// and its resume rules from apps/web/src/markdown-incremental.ts at commit 5c6f2f12.
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

/** A code fence the text ends inside, as the element it renders once closed. */
export interface OpenCode {
  /** The content lines, as remark reads them once the fence closes. */
  readonly code: string
  /** The info string's first word, or null. */
  readonly lang: string | null
}

/** Text cut into blocks, and what a longer streamed text needs to resume the cut. */
export interface MarkdownBlocks {
  readonly text: string
  readonly blocks: readonly string[]
  /** Set when the last block is a top-level code fence that has not closed. */
  readonly openCode: OpenCode | null
}

/**
 * Cuts Markdown at blank lines that close every open block, so each piece
 * renders exactly as it would inside the whole text, and a streaming answer
 * re-parses only its last piece. Returns null when the text uses syntax that
 * spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  const result = scanMarkdownBlocks(text)
  return result && [...result.blocks]
}

/**
 * `splitMarkdownBlocks`, plus the open fence at the end. Given the result for
 * an earlier text that this one extends, it rescans only from the last cut
 * that appended text cannot undo.
 */
export function scanMarkdownBlocks(text: string, previous?: MarkdownBlocks | null): MarkdownBlocks | null {
  if (previous?.text === text) return previous
  if (!previous || !text.startsWith(previous.text)) return scan(text, 0, [])
  const { blocks } = previous
  // A cut depends only on the lines up to the one that starts the next block. That line
  // can still grow while it is the last one (`2` may become `2.`, continuing a list).
  const kept = blocks.length > 1 && !blocks[blocks.length - 1].includes('\n') ? blocks.length - 2 : blocks.length - 1
  let resumeAt = previous.text.length
  for (let index = kept; index < blocks.length; index++) resumeAt -= blocks[index].length
  return scan(text, resumeAt, blocks.slice(0, kept))
}

// Scans from `blockStart`, the start of a block, where no fence is open.
function scan(text: string, blockStart: number, blocks: string[]): MarkdownBlocks | null {
  // Streaming CR may become CRLF; parsing a block alone would strip an internal BOM.
  if (text.includes('\r', blockStart) || text.includes('\uFEFF', blockStart)) return null
  let lineStart = blockStart
  let fence: string | null = null
  let fenceIndent = 0
  let fenceStart = 0
  let afterBlankLine = false
  let whole = false
  for (const line of text.slice(blockStart).split('\n')) {
    const opener = FENCE_PATTERN.exec(line)?.[1]
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which isn't tracked;
      // the rest stays one block, so it must not use document-wide syntax either.
      if (/\S/.test(line.slice(0, fenceIndent))) {
        if (DOCUMENT_WIDE_SYNTAX.test(text.slice(lineStart))) return null
        whole = true
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
      if (opener) {
        fenceIndent = line.indexOf(opener)
        fenceStart = lineStart
      }
    }
    lineStart += line.length + 1
  }
  const last = text.slice(blockStart)
  blocks.push(last)
  // A block only starts with an unindented line, or at the top of the text, so a fence
  // that opens its block is not inside a list item or quote.
  const openCode = fence !== null && !whole && fenceStart === blockStart ? readOpenCode(last, fence, fenceIndent) : null
  return { text, blocks, openCode }
}

/**
 * Reads a block that is a fence still open at the end of the text as remark reads
 * it with a closing fence added, or null where that needs more than this handles.
 */
function readOpenCode(block: string, fence: string, indent: number): OpenCode | null {
  const openerEnd = block.indexOf('\n')
  const info = (openerEnd === -1 ? block : block.slice(0, openerEnd)).slice(indent + fence.length)
  // Escapes and character references in the info string are decoded; a tab in an
  // indented fence's content counts as spaces.
  if (/[\\&]/.test(info) || (indent > 0 && block.includes('\t'))) return null
  const lang = /^[ \t]*([^ \t]*)/.exec(info)?.[1] || null
  if (openerEnd === -1) return { code: '', lang }
  // The closing fence would go on its own line, which takes a trailing newline.
  let code = block.slice(openerEnd + 1).replace(/\n$/, '')
  // Each content line loses up to as many spaces as the opener is indented.
  if (indent > 0) code = code.replace(new RegExp(`^ {1,${indent}}`, 'gm'), '')
  return { code: code.replaceAll('\0', '\uFFFD'), lang }
}
