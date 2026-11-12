import { describe, expect, it } from 'vitest'

import { withoutPersonalDetails } from './replay'

describe('Codex recording', () => {
  it('drops MCP server details, disabled plugin ids and the plan, and keeps the shape', () => {
    const status = {
      type: 'emit_inbound' as const,
      label: 'mcpServer/startupStatus/updated',
      frame: { method: 'mcpServer/startupStatus/updated', params: { name: 'ada-notes', status: 'failed', error: 'spawn /opt/ada/bin failed', threadId: null } },
    }
    expect(withoutPersonalDetails(status)).toEqual({
      ...status,
      frame: { method: 'mcpServer/startupStatus/updated', params: { name: 'replay-mcp', status: 'failed', error: '<redacted>', threadId: null } },
    })

    const started = {
      type: 'emit_inbound' as const,
      label: 'thread/start',
      frame: { id: 4, result: { model: 'gpt', disabledPluginIds: ['ada-private-plugin'], thread: { settings: { disabledPluginIds: ['x'] } } } },
    }
    expect(withoutPersonalDetails(started)).toEqual({
      ...started,
      frame: { id: 4, result: { model: 'gpt', disabledPluginIds: [], thread: { settings: { disabledPluginIds: [] } } } },
    })

    const account = {
      type: 'emit_inbound' as const,
      label: 'account/read',
      frame: { id: 2, result: { account: { type: 'chatgpt', email: 'ada@school.edu', planType: 'pro' }, requiresOpenaiAuth: true } },
    }
    // The email is the scrubber's; only the plan is this function's.
    expect(withoutPersonalDetails(account)).toEqual({
      ...account,
      frame: { id: 2, result: { account: { type: 'chatgpt', email: 'ada@school.edu', planType: 'unknown' }, requiresOpenaiAuth: true } },
    })
  })
})
