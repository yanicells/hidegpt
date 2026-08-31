/**
 * Docs-looking wrapper around the local Codex app-server.
 *
 *   bun run dev
 */

import { CodexSession } from './src/codex/session'
import { AppRoot } from './src/ui/app-root'
import { render } from '@gpuix/react'

const session = new CodexSession()

export function HideGptApp({ session: injected }: { session?: CodexSession }) {
  return <AppRoot session={injected ?? session} />
}

const isEntryPoint =
  typeof Bun !== 'undefined'
    ? Bun.isStandaloneExecutable || Bun.main === import.meta.path
    : typeof window !== 'undefined'

if (isEntryPoint) {
  render(<HideGptApp />, {
    title: 'Docs',
    width: 1280,
    height: 840,
    titlebarTransparent: true,
    windowBackground: 'opaque',
    trafficLightX: 16,
    trafficLightY: 14,
    focus: typeof process === 'undefined' || process.env.GPUIX_BACKGROUND !== '1',
  })
}
