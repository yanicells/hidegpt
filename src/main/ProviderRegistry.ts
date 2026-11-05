import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import type { ProviderId } from '../shared/model'
import { ProcessSupervisor } from '../provider/ProcessSupervisor'
import type { ProviderAdapter } from '../provider/ProviderAdapter'

/**
 * Where the session manager gets adapters (T3 Code's `ProviderAdapterRegistry`).
 * Adapters load on first use with a dynamic import, so the Home path never
 * pays for a provider's protocol schemas or SDK until that library connects.
 */
export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  { readonly adapter: (id: ProviderId) => Effect.Effect<ProviderAdapter> }
>()('hidegpt/ProviderRegistry') {}

type Loaders = { readonly [K in ProviderId]: () => Promise<ProviderAdapter> }

const fromLoaders = (loaders: Loaders) =>
  ProviderRegistry.of({ adapter: (id) => Effect.promise(loaders[id]) })

/** Adapters that load on first use (demo mode); each loader runs once, so a reconnect keeps its library. */
export const layerLoaders = (loaders: Loaders) => {
  const loaded = new Map<ProviderId, Promise<ProviderAdapter>>()
  const once = (id: ProviderId) => () => {
    let adapter = loaded.get(id)
    if (!adapter) loaded.set(id, (adapter = loaders[id]()))
    return adapter
  }
  return Layer.succeed(ProviderRegistry, fromLoaders({ codex: once('codex'), opencode: once('opencode'), claude: once('claude') }))
}

/** The real providers, each spawned under the shared process supervisor. */
export const layer = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const supervisor = yield* ProcessSupervisor
    return fromLoaders({
      codex: () => import('../codex/CodexAdapter').then((m) => m.make(m.spawnAppServer(supervisor))),
      opencode: () => import('../opencode/OpenCodeAdapter').then((m) => m.make(m.spawnServer(supervisor))),
      claude: () => import('../claude/ClaudeAdapter').then((m) => m.make()),
    })
  }),
)

/** Fixed adapters (tests and demo mode). */
export const layerAdapters = (adapters: Partial<Record<ProviderId, ProviderAdapter>>) =>
  Layer.succeed(
    ProviderRegistry,
    ProviderRegistry.of({
      adapter: (id) => {
        const adapter = adapters[id]
        return adapter ? Effect.succeed(adapter) : Effect.die(new Error(`No ${id} adapter in this registry`))
      },
    }),
  )
