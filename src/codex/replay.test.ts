import { describe, expect, it } from 'vitest'

import { withoutPersonalLists } from './replay'

describe('Codex recording', () => {
  it('drops MCP server details and disabled plugin ids, and keeps the shape', () => {
    const status = {
      type: 'emit_inbound' as const,
      label: 'mcpServer/startupStatus/updated',
      frame: { method: 'mcpServer/startupStatus/updated', params: { name: 'ada-notes', status: 'failed', error: 'spawn /opt/ada/bin failed', threadId: null } },
    }
    expect(withoutPersonalLists(status)).toMatchObject({
      frame: {
      method: 'mcpServer/startupStatus/updated',
        params: { name: 'replay-mcp', status: 'failed', error: '<redacted>', threadId: null },
      },
    })

    const started = {
      type: 'emit_inbound' as const,
      label: 'thread/start',
      frame: { id: 4, result: { model: 'gpt', disabledPluginIds: ['ada-private-plugin'], thread: { settings: { disabledPluginIds: ['x'] } } } },
    }
    expect(withoutPersonalLists(started)).toEqual({
      ...started,
      frame: { id: 4, result: { model: 'gpt', disabledPluginIds: [], thread: { settings: { disabledPluginIds: [] } } } },
    })
  })
})
