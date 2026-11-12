import { describe, expect, it } from 'vitest'

import { readTranscript, type ReplayEntry } from '../provider/replayFixture'
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

  it('empties the lists in MCP server, skill, plugin and app answers and notifications', () => {
    const servers: ReplayEntry = {
      type: 'emit_inbound',
      label: 'mcpServerStatus/list',
      frame: { id: 6, result: { data: [{ name: 'ada-notes', tools: { search: {} }, authStatus: 'oAuth' }], nextCursor: 'c-2' } },
    }
    expect(withoutPersonalDetails(servers)).toEqual({ ...servers, frame: { id: 6, result: { data: [], nextCursor: 'c-2' } } })

    const skills: ReplayEntry = {
      type: 'emit_inbound',
      label: 'skills/list',
      frame: { id: 7, result: { data: [{ cwd: '/x', skills: [{ name: 'school-briefing' }], errors: [] }] } },
    }
    expect(withoutPersonalDetails(skills)).toEqual({ ...skills, frame: { id: 7, result: { data: [] } } })

    const apps: ReplayEntry = {
      type: 'emit_inbound',
      label: 'app/list/updated',
      frame: { method: 'app/list/updated', params: { data: [{ id: 'canvas', name: 'Canvas' }] } },
    }
    expect(withoutPersonalDetails(apps)).toEqual({ ...apps, frame: { method: 'app/list/updated', params: { data: [] } } })

    // What Docs sends stays as recorded, or the replay would stop matching it.
    const request: ReplayEntry = { type: 'expect_outbound', label: 'skills/list', frame: { id: 7, method: 'skills/list', params: { cwds: ['/x'] } } }
    expect(withoutPersonalDetails(request)).toEqual(request)
  })

  it('leaves models and threads alone', () => {
    const models: ReplayEntry = { type: 'emit_inbound', label: 'model/list', frame: { id: 3, result: { data: [{ id: 'gpt-5.5' }], nextCursor: null } } }
    const threads: ReplayEntry = { type: 'emit_inbound', label: 'thread/list', frame: { id: 5, result: { data: [{ id: 't-1', preview: 'docs' }], nextCursor: null } } }
    expect(withoutPersonalDetails(models)).toEqual(models)
    expect(withoutPersonalDetails(threads)).toEqual(threads)
  })

  it('the committed fixtures are already clean', () => {
    const entries = readTranscript(new URL('./fixtures/library.ndjson', import.meta.url).pathname).entries
    expect(entries.map(withoutPersonalDetails)).toEqual(entries)
  })
})
