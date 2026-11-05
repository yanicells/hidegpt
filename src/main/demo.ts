import * as ClaudeAdapter from '../claude/ClaudeAdapter'
import { makeDemoClaude } from '../claude/demo'
import * as CodexAdapter from '../codex/CodexAdapter'
import { makeDemoCodex } from '../codex/demo'
import * as OpenCodeAdapter from '../opencode/OpenCodeAdapter'
import { makeDemoOpenCode } from '../opencode/demo'
import { layerAdapters } from './ProviderRegistry'

/**
 * `HIDEGPT_FAKE=1`: every library runs its real adapter against an
 * in-process fake backend, so the app works (and screenshots run) with no
 * provider installed and no model usage.
 */
export const demoCodex = makeDemoCodex()
const demoClaude = makeDemoClaude()

export const layer = layerAdapters({
  codex: CodexAdapter.make(demoCodex.connect),
  opencode: OpenCodeAdapter.make(makeDemoOpenCode().connect),
  claude: ClaudeAdapter.make(() => Promise.resolve(demoClaude.sdk)),
})
