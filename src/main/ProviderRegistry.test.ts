import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { BinaryMissingError } from '../provider/errors'
import { ProcessSupervisor, type SupervisedProcess } from '../provider/ProcessSupervisor'
import { retryOnFreshPath } from './ProviderRegistry'

const started = {} as SupervisedProcess
const options = { provider: 'codex', command: 'codex', args: ['app-server'] } as const

/** A supervisor whose command is found only on `found`, and the PATH it sees. */
function fakeSupervisor(found: string) {
  let path = 'cached'
  let spawns = 0
  const supervisor = ProcessSupervisor.of({
    spawn: () =>
      Effect.suspend(() => {
        spawns++
        return path === found
          ? Effect.succeed(started)
          : Effect.fail(new BinaryMissingError({ provider: 'codex', command: 'codex' }))
      }),
    callbackSpawner: Effect.die('not used'),
    reapOrphans: Effect.succeed(0),
  })
  return {
    supervisor,
    currentPath: () => path,
    setPath: (next: string) => (path = next),
    spawns: () => spawns,
  }
}

describe('retryOnFreshPath', () => {
  it.effect('a missing command waits for the refresh, then starts on the new PATH', () =>
    Effect.gen(function* () {
      const fake = fakeSupervisor('fresh')
      const refreshed = () => Promise.resolve(fake.setPath('fresh'))
      const spawned = yield* retryOnFreshPath(fake.supervisor, refreshed, fake.currentPath).spawn(options)
      expect(spawned).toBe(started)
      expect(fake.spawns()).toBe(2)
    }),
  )

  it.effect('reports it missing without a second try when the refresh left PATH as it was', () =>
    Effect.gen(function* () {
      const fake = fakeSupervisor('fresh')
      const error = yield* Effect.flip(
        retryOnFreshPath(fake.supervisor, () => Promise.resolve(), fake.currentPath).spawn(options),
      )
      expect(error).toBeInstanceOf(BinaryMissingError)
      expect(fake.spawns()).toBe(1)
    }),
  )
})
