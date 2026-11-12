import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import * as ClaudeAdapter from '../claude/ClaudeAdapter'
import { makeFakeClaude } from '../claude/FakeClaude'
import * as CodexAdapter from '../codex/CodexAdapter'
import { makeFakeCodex } from '../codex/FakeCodex'
import * as OpenCodeAdapter from '../opencode/OpenCodeAdapter'
import { makeFakeOpenCode } from '../opencode/FakeOpenCode'
import { CAPABILITIES } from '../shared/model'
import { fromLegacy } from './legacyEvents'
import { capabilityMismatches, type ProviderAdapter, type ProviderSession } from './ProviderAdapter'

/**
 * The renderer shows sign-in, "Connect" and "Add project" from the capability flags;
 * the manager calls the session's optional methods. Each adapter must agree with both,
 * as the manager sees it (through `fromLegacy`, which must keep exactly the methods it got).
 */
const ADAPTERS: ReadonlyArray<ProviderAdapter> = [
  fromLegacy(CodexAdapter.make(makeFakeCodex().connect)),
  fromLegacy(OpenCodeAdapter.make(makeFakeOpenCode().connect)),
  fromLegacy(ClaudeAdapter.make(() => Promise.resolve(makeFakeClaude().sdk))),
]

const session = (overrides: Partial<ProviderSession>) => overrides as ProviderSession

describe('capabilities', () => {
  it('covers every provider', () => {
    expect(ADAPTERS.map((adapter) => adapter.id).toSorted()).toEqual(Object.keys(CAPABILITIES).toSorted())
  })

  for (const adapter of ADAPTERS) {
    it.effect(`${adapter.id}: the flags match the session's optional methods`, () =>
      Effect.gen(function* () {
        expect(adapter.capabilities).toEqual(CAPABILITIES[adapter.id])
        const opened = yield* adapter.openSession
        expect(capabilityMismatches(adapter.capabilities, opened)).toEqual([])
      }),
    )
  }

  it('names each flag that disagrees with a method', () => {
    const flags = { login: true, connectTools: false, createProjects: false, gitProjects: false }
    const login = Effect.succeed('https://example.test/login')
    expect(capabilityMismatches(flags, session({ login }))).toEqual(['login: true but logout is missing'])
    expect(capabilityMismatches({ ...flags, login: false }, session({ connectTool: () => login }))).toEqual([
      'connectTools: false but connectTool is present',
    ])
  })
})
