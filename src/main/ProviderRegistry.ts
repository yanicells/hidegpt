import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import type { ProviderId } from '../shared/model'
import { PERSONAL_BUILD, providerLabel } from '../shared/labels'
import { reportDefect } from '../provider/DefectReport'
import { ProviderRequestError } from '../provider/errors'
import { ProcessSupervisor } from '../provider/ProcessSupervisor'
import type { ProviderAdapter } from '../provider/ProviderAdapter'

/**
 * Where the session manager gets adapters (T3 Code's `ProviderAdapterRegistry`).
 * Adapters load on first use with a dynamic import, so the Home path never
 * pays for a provider's protocol schemas or SDK until that library connects.
 */
export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  { readonly adapter: (id: ProviderId) => Effect.Effect<ProviderAdapter, ProviderRequestError> }
>()('hidegpt/ProviderRegistry') {}

type Loaders = { readonly [K in ProviderId]: () => Promise<ProviderAdapter> }

/**
 * A chunk that fails to load is an error on that library's banner, not a defect that ends
 * supervision. Why it failed goes to the log under a report id, not onto the page.
 */
const fromLoaders = (loaders: Loaders) =>
  ProviderRegistry.of({
    adapter: (id) =>
      // A rejected import is a defect: reported with its cause, then turned into the banner error.
      Effect.promise(loaders[id]).pipe(
        Effect.catchCauseIf(Cause.hasDies, (cause) =>
          reportDefect(cause).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderRequestError({
                  provider: id,
                  operation: 'load',
                  detail: `Docs could not load ${providerLabel(id)}. Docs saved a report.`,
                }),
              ),
            ),
          ),
        ),
      ),
  })

/**
 * Adapters that load on first use (demo mode). A loaded adapter is kept, so a reconnect
 * keeps its library; a failed load is not, so the next connect tries again.
 */
export const layerLoaders = (loaders: Loaders) => {
  const loaded = new Map<ProviderId, Promise<ProviderAdapter>>()
  const once = (id: ProviderId) => () => {
    let adapter = loaded.get(id)
    if (!adapter) {
      const loading = loaders[id]()
      loaded.set(id, loading)
      loading.catch(() => loaded.get(id) === loading && loaded.delete(id))
      adapter = loading
    }
    return adapter
  }
  return Layer.succeed(
    ProviderRegistry,
    fromLoaders({ codex: once('codex'), opencode: once('opencode'), claude: once('claude') }),
  )
}

/**
 * The Claude loader of a shared build. `PERSONAL_BUILD` is a build-time constant,
 * so the bundler drops the Claude import from such a build entirely.
 */
export const notInThisBuild = (): Promise<ProviderAdapter> =>
  Promise.reject(new Error('this library is not part of this build'))

/**
 * The real providers, each spawned under the shared process supervisor. No adapter
 * loads (so no CLI is looked up on PATH) until `ready` settles; main passes its
 * login-shell PATH lookup here, so a provider can start before the window has
 * painted without ever missing a CLI installed under nvm and the like.
 */
export const layerAfter = (ready: Promise<unknown>) =>
  Layer.effect(
    ProviderRegistry,
    Effect.gen(function* () {
      const supervisor = yield* ProcessSupervisor
      return fromLoaders({
        codex: () =>
          ready.then(() => import('../codex/CodexAdapter')).then((m) => m.make(m.spawnAppServer(supervisor))),
        opencode: () =>
          ready.then(() => import('../opencode/OpenCodeAdapter')).then((m) => m.make(m.spawnServer(supervisor))),
        claude: PERSONAL_BUILD
          ? () => ready.then(() => import('../claude/ClaudeAdapter')).then((m) => m.make(undefined, supervisor))
          : notInThisBuild,
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
