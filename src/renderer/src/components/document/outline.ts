import type { Block } from '../../../../shared/model'

/**
 * One row of the "Document tabs" outline. Questions are Heading 1; answer
 * sections (`#`–`###`, all Docs Heading 2 on the page) nest beneath them.
 * `heading` is the section's position among the block's rendered h1–h3,
 * which is how a jump finds it.
 */
export type OutlineEntry = {
  key: string
  blockId: string
  text: string
  level: 1 | 2
  heading?: number
}

// Blocks keep their identity until they change, so each one is parsed once
// per version; a streamed delta re-reads only the block being written.
const entriesByBlock = new WeakMap<Block, OutlineEntry[]>()

/** The outline for the blocks on the page, in document order. */
export function outlineEntries(blocks: ReadonlyArray<Block>): OutlineEntry[] {
  return blocks.flatMap((block) => {
    let entries = entriesByBlock.get(block)
    if (!entries) {
      entries = blockEntries(block)
      entriesByBlock.set(block, entries)
    }
    return entries
  })
}

function blockEntries(block: Block): OutlineEntry[] {
  if (block.kind === 'user') {
    return [{ key: block.id, blockId: block.id, text: block.text || (block.images ? 'Image' : 'Untitled'), level: 1 }]
  }
  if (block.kind !== 'agent') return []
  return sectionHeadings(block.text).flatMap((text, heading): OutlineEntry[] =>
    text ? [{ key: `${block.id}-${heading}`, blockId: block.id, text, level: 2, heading }] : [],
  )
}

/** ATX `#`–`###` headings outside code fences, inline markup stripped; one entry per rendered heading. */
export function sectionHeadings(markdown: string): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker[0]
      else if (marker[0] === fence) fence = null
      continue
    }
    if (fence) continue
    const match = /^ {0,3}#{1,3}[ \t]+(.+?)[ \t#]*$/.exec(line)
    if (match) out.push(plain(match[1]))
  }
  return out
}

function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim()
}
