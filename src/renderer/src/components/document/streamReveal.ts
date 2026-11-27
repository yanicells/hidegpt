// A line that starts a GFM table row. Until a line after it arrives, a header
// row would show as plain text and then turn into a table.
const TABLE_ROW = /^ {0,3}\|/

/**
 * The part of a streaming answer that is ready to show: whole lines only, as
 * a paste or a collaborator's edit lands in Docs, so a line never re-flows as
 * it grows. A table waits until a line after it arrives, then lands whole.
 * Streamed text only grows, so what this returns only grows too.
 */
export function revealedText(text: string): string {
  let end = text.lastIndexOf('\n') + 1
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 2) + 1
    if (!TABLE_ROW.test(text.slice(start, end))) break
    end = start
  }
  return text.slice(0, end)
}
