import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { leaks, type RecordingMachine, recordNames, scrub, turnsAllowed } from './replayFixture'

const MACHINE: RecordingMachine = {
  home: '/Users/ada',
  people: ['ada', 'Ada', 'Lovelace'],
  hosts: ['adas-mbp.local', 'adas-mbp', "Ada's MacBook Pro"],
  scratch: [['/private/var/folders/x1/abc/T/hidegpt-replay-workspace-1', '/tmp/replay-workspace']],
}

const SRC = new URL('..', import.meta.url).pathname
const FIXTURES = ['codex', 'claude'].flatMap((provider) => {
  const dir = join(SRC, provider, 'fixtures')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ndjson'))
    .map((name) => join(dir, name))
})

describe('replay fixtures', () => {
  it('scrub replaces machine identity, emails and secrets, and keeps everything else', () => {
    const frame = {
      account: { email: 'ada.lovelace@school.edu', planType: 'plus' },
      cwd: '/private/var/folders/x1/abc/T/hidegpt-replay-workspace-1/notes',
      path: '/Users/ada/.codex/skills/a/SKILL.md',
      other: '/Users/someone/project',
      serverName: 'adas-mbp.local',
      shortHost: 'ws://adas-mbp:4000',
      computer: "Shared from Ada's MacBook Pro",
      note: 'ADA wrote this, LOVELACE signed it; adamant stays',
      authorization: 'Bearer abc',
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
      refreshToken: false,
      text: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    }
    expect(scrub(frame, MACHINE)).toEqual({
      account: { email: 'replay-user@example.com', planType: 'plus' },
      cwd: '/tmp/replay-workspace/notes',
      path: '/home/replay-user/.codex/skills/a/SKILL.md',
      other: '/home/replay-user/project',
      serverName: 'replay-host',
      shortHost: 'ws://replay-host:4000',
      computer: 'Shared from replay-host',
      note: 'replay-user wrote this, replay-user signed it; adamant stays',
      authorization: '<redacted>',
      accessToken: '<redacted>',
      refreshToken: false,
      text: 'key <redacted>',
    })
    expect(leaks(JSON.stringify(scrub(frame, MACHINE)), MACHINE)).toEqual([])
  })

  it('leaks finds what scrubbing must remove, in any case', () => {
    expect(leaks('{"email":"ada@school.edu","cwd":"/Users/bob/x","by":"Lovelace","host":"ADAS-MBP"}', MACHINE)).toEqual(
      ['ada@school.edu', '/Users/bob', 'ADAS-MBP', 'Lovelace', 'ada'],
    )
  })

  it('an empty home or a short name never counts as a leak', () => {
    expect(leaks('{"a":"to be or not"}', { home: '', people: ['', 'to'], hosts: [''], scratch: [] })).toEqual([])
    expect(scrub('/x/y', { home: '', people: [''], hosts: [''], scratch: [] })).toBe('/x/y')
  })

  it('a name that is a placeholder word is not treated as personal', () => {
    const machine: RecordingMachine = {
      home: '',
      people: ['user', 'Replay', 'Example'],
      hosts: ['host'],
      scratch: [['/private/var/folders/x1/abc/T/w', '/tmp/replay-workspace']],
    }
    const text =
      '{"email":"replay-user@example.com","cwd":"/tmp/replay-workspace","host":"replay-host","key":"<redacted>"}'
    expect(leaks(text, machine)).toEqual([])
    expect(scrub(text, machine)).toBe(text)
  })

  it('HIDEGPT_RECORD_NAMES adds names to scrub and to check', () => {
    const names = recordNames({ HIDEGPT_RECORD_NAMES: ' Ada Lovelace , Analytical Engines,,' })
    expect(names).toEqual(['Ada Lovelace', 'Analytical Engines'])
    expect(recordNames({})).toEqual([])
    const machine: RecordingMachine = { home: '', people: names, hosts: [], scratch: [] }
    const text = 'Ada Lovelace works at analytical engines'
    expect(leaks(text, machine)).toEqual(['analytical engines', 'Ada Lovelace'])
    expect(scrub(text, machine)).toBe('replay-user works at replay-user')
  })

  // Names are per machine (a CI runner is called "runner"), so the recorders check those;
  // this checks what no fixture may hold on any machine.
  it.each(FIXTURES.map((path) => [path.slice(SRC.length), path]))(
    '%s has no emails, home or temp paths, or tokens',
    (_name, path) => {
      const text = readFileSync(path, 'utf8')
      expect(leaks(text, { home: '', people: [], hosts: [], scratch: [] })).toEqual([])
    },
  )

  it('turns are refused unless a person sets HIDEGPT_RECORD_TURNS=1', () => {
    expect(turnsAllowed({})).toBe(false)
    expect(turnsAllowed({ HIDEGPT_RECORD_TURNS: 'true' })).toBe(false)
    expect(turnsAllowed({ HIDEGPT_RECORD_TURNS: '1' })).toBe(true)
  })
})
