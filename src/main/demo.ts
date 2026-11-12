import { PERSONAL_BUILD } from '../shared/labels'
import { layerLoaders, notInThisBuild } from './ProviderRegistry'

/**
 * `HIDEGPT_FAKE=1`: every library runs its real adapter against an
 * in-process fake backend, so the app works (and screenshots run) with no
 * provider installed and no model usage. Like the real adapters, each fake
 * loads only when its library first connects.
 */
export const layer = layerLoaders({
  codex: async () => {
    const [{ make }, { makeDemoCodex }] = await Promise.all([import('../codex/CodexAdapter'), import('../codex/demo')])
    return make(makeDemoCodex().connect)
  },
  opencode: async () => {
    const [{ make }, { makeDemoOpenCode }] = await Promise.all([import('../opencode/OpenCodeAdapter'), import('../opencode/demo')])
    return make(makeDemoOpenCode().connect)
  },
  claude: PERSONAL_BUILD
    ? async () => {
        const [{ make }, { makeDemoClaude }] = await Promise.all([import('../claude/ClaudeAdapter'), import('../claude/demo')])
        const demo = makeDemoClaude()
        return make(() => Promise.resolve(demo.sdk))
      }
    : notInThisBuild,
})
