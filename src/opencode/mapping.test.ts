import { describe, expect, it } from 'vitest'

import { toolCallout } from './mapping'

type ToolPart = Parameters<typeof toolCallout>[0]

describe('toolCallout', () => {
  it('shows a failed tool in Docs’ words, never its error text', () => {
    const part = { id: 'p1', tool: 'bash', state: { status: 'error', error: 'EACCES: permission denied' } }
    expect(toolCallout(part as unknown as ToolPart)).toEqual({
      kind: 'callout',
      id: 'p1',
      title: 'A step didn’t finish',
      body: '',
    })
  })
})
