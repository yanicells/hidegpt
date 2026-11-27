import type { Components } from 'hast-util-to-jsx-runtime'
import { memo, useDeferredValue, useRef } from 'react'
import { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { createMarkdownRenderer } from './markdownRenderer'
import { scanMarkdownBlocks, type MarkdownBlocks, type OpenCode } from './markdownStreamBlocks'

// Links open in the browser: main's window-open handler hands `_blank` links to the OS.
const components: Partial<Components> = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

const renderer = createMarkdownRenderer({ remarkPlugins: [remarkGfm], components, urlTransform: defaultUrlTransform })

/**
 * Renders an answer block by block. While it streams, only the last block
 * re-parses, and not even that while it is an open code fence; finished
 * blocks come from the shared cache, so reopening a document does not parse
 * it again.
 */
export const AgentMarkdown = memo(function AgentMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const deferredText = useDeferredValue(text)
  // The previous render's cut. A streamed text extends it, so the scan resumes near its end.
  const scanned = useRef<MarkdownBlocks | null>(null)
  const scan = scanMarkdownBlocks(deferredText, scanned.current)
  scanned.current = scan
  const blocks = scan?.blocks ?? [deferredText]
  // A render that still shows an older prefix may end mid-block, so its last block is not cached.
  // Earlier blocks keep their props through it, so they skip rendering again.
  const current = deferredText === text
  return (
    <div className="doc-body">
      {blocks.map((block, index) => {
        const last = index === blocks.length - 1
        return (
          <MarkdownBlock
            // Streamed blocks only change at the end, so the index is a stable key.
            // oxlint-disable-next-line react/no-array-index-key -- see above
            key={index}
            text={block}
            cache={!last || (current && !streaming)}
            openCode={last ? (scan?.openCode ?? null) : null}
          />
        )
      })}
    </div>
  )
})

/**
 * One block. An open fence renders as the code block it will close into,
 * element for element, so nothing remounts when the closing fence arrives.
 */
const MarkdownBlock = memo(function MarkdownBlock({
  text,
  cache,
  openCode,
}: {
  text: string
  cache: boolean
  openCode: OpenCode | null
}) {
  return openCode ? renderer.codeBlock(openCode.code, openCode.lang) : renderer.markdown(text, cache)
})
