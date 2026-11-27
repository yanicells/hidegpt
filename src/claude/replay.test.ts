import { describe, expect, it } from 'vitest'

import { readTranscript, type ReplayEntry } from '../provider/replayFixture'
import { withoutPersonalDetails } from './replay'

const message = (body: Record<string, unknown>): ReplayEntry => ({ type: 'emit_inbound', label: 'message', frame: { query: 1, message: body } })
const messageOf = (entry: ReplayEntry) => (entry.type === 'emit_inbound' ? (entry.frame as { message: unknown }).message : undefined)
const ids = { uuid: 'u-1', session_id: 's-1' }

describe('Claude recording', () => {
  it('rebuilds init from allowed fields and empties its lists', () => {
    const init = message({
      type: 'system',
      subtype: 'init',
      ...ids,
      cwd: '/tmp/replay-workspace',
      model: 'claude-opus-5-5',
      permissionMode: 'default',
      apiKeySource: 'none',
      claude_code_version: '3.0.0',
      output_style: 'default',
      tools: ['Read', 'mcp__notion__search'],
      mcp_servers: [{ name: 'notion', status: 'connected' }],
      slash_commands: ['school-briefing'],
      skills: ['school-briefing'],
      plugins: [{ name: 'canvas', path: '/x' }],
      agents: ['claude'],
      plugin_errors: [{ plugin: 'canvas', message: 'token for ada@school.edu expired' }],
      memory_paths: { auto: '/x/memory' },
    })
    expect(messageOf(withoutPersonalDetails(init))).toEqual({
      type: 'system',
      subtype: 'init',
      ...ids,
      cwd: '/tmp/replay-workspace',
      model: 'claude-opus-5-5',
      permissionMode: 'default',
      apiKeySource: 'none',
      claude_code_version: '3.0.0',
      output_style: 'default',
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      plugins: [],
      agents: [],
    })
  })

  it('empties commands_changed, keeps only ids of other system messages, and cuts rate limits to their status', () => {
    const commands = message({ type: 'system', subtype: 'commands_changed', ...ids, commands: [{ name: 'school-briefing', description: 'Reads Canvas, Notion and Gmail' }] })
    expect(messageOf(withoutPersonalDetails(commands))).toEqual({ type: 'system', subtype: 'commands_changed', ...ids, commands: [] })

    const recall = message({ type: 'system', subtype: 'memory_recall', ...ids, paths: ['/x/memory/notes.md'], content: 'Ada studies at ...' })
    expect(messageOf(withoutPersonalDetails(recall))).toEqual({ type: 'system', subtype: 'memory_recall', ...ids })

    const limit = message({ type: 'rate_limit_event', ...ids, rate_limit_info: { status: 'allowed', utilization: 0.4, overageStatus: 'rejected', seatTier: 'max' } })
    expect(messageOf(withoutPersonalDetails(limit))).toEqual({ type: 'rate_limit_event', ...ids, rate_limit_info: { status: 'allowed' } })

    // What Docs reads stays as recorded; paths in `result.errors` are the scrubber's.
    const result = message({ type: 'result', subtype: 'error_during_execution', ...ids, errors: ['Request was aborted.'] })
    expect(withoutPersonalDetails(result)).toEqual(result)
  })

  it("keeps only Claude Code's built-in commands in probe answers", () => {
    const answer: ReplayEntry = {
      type: 'emit_inbound',
      label: 'query.initializationResult',
      frame: { call: 'initializationResult', query: 1, result: { commands: [{ name: 'compact', builtin: true }, { name: 'school-briefing' }], models: [] } },
    }
    expect(withoutPersonalDetails(answer)).toEqual({
      ...answer,
      frame: { call: 'initializationResult', query: 1, result: { commands: [{ name: 'compact', builtin: true }], models: [] } },
    })
  })

  it('keeps only commands, models and the login source of a hostile probe answer', () => {
    const answer: ReplayEntry = {
      type: 'emit_inbound',
      label: 'query.initializationResult',
      frame: {
        call: 'initializationResult',
        query: 1,
        result: {
          commands: [{ name: 'compact', builtin: true }, { name: 'school-briefing', description: 'Reads Canvas' }],
          agents: [{ name: 'ada-tutor', description: 'Knows my courses' }],
          models: [{ value: 'opus' }],
          account: { tokenSource: 'claude.ai', apiProvider: 'firstParty', email: 'ada@school.edu', organization: 'Ada School', subscriptionType: 'max' },
          output_style: 'ada-style',
          available_output_styles: ['default', 'ada-style'],
          user_output_styles_dir: '/Users/ada/.claude/output-styles',
          pid: 4242,
        },
      },
    }
    expect(withoutPersonalDetails(answer)).toEqual({
      ...answer,
      frame: {
        call: 'initializationResult',
        query: 1,
        result: { commands: [{ name: 'compact', builtin: true }], models: [{ value: 'opus' }], account: { tokenSource: 'claude.ai', apiProvider: 'firstParty' } },
      },
    })
  })

  it('the committed fixtures are already clean', () => {
    const entries = readTranscript(new URL('./fixtures/library.ndjson', import.meta.url).pathname).entries
    expect(entries.map(withoutPersonalDetails)).toEqual(entries)
  })
})
