const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CONTINUES = /^(\s|[-*+]\s|\d+[.)]\s|>|\|)/
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:\s/m

/**
 * Splits Markdown into top-level chunks at blank lines, so a streaming answer
 * only re-parses its last chunk. Blank lines inside code fences, before
 * indented or list/quote/table lines (loose lists, nested content) never
 * split. Text with link reference definitions stays whole, because those
 * resolve across the entire document.
 */
export function markdownChunks(text: string): string[] {
  if (LINK_DEFINITION.test(text)) return [text]
  const chunks: string[] = []
  const lines = text.split('\n')
  let current: string[] = []
  let fence: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const marker = FENCE.exec(line)?.[1]
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? null : marker
    }
    current.push(line)
    if (fence || line.trim() !== '') continue
    let after = index + 1
    while (after < lines.length && lines[after].trim() === '') after += 1
    if (after === lines.length || CONTINUES.test(lines[after])) continue
    chunks.push(current.join('\n'))
    current = []
  }
  if (current.length) chunks.push(current.join('\n'))
  return chunks
}
