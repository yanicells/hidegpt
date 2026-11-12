import { describe, expect, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'
import * as Schema from 'effect/Schema'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { handle } from './ipc'

type Listener = (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>

/** Just the part of IpcMain that `handle` uses: one listener per channel. */
function fakeIpcMain() {
  const listeners = new Map<string, Listener>()
  const ipcMain = {
    handle: (channel: string, listener: Listener) => void listeners.set(channel, listener),
    removeHandler: (channel: string) => void listeners.delete(channel),
  }
  const invoke = (channel: string, raw: unknown) => listeners.get(channel)!({} as IpcMainInvokeEvent, raw)
  return { ipcMain: ipcMain as unknown as IpcMain, invoke }
}

describe('ipc.handle', () => {
  it.effect('reports a handler that dies, and still rejects the invoke', () => {
    const logged: Array<{ readonly cause: string; readonly annotations: Record<string, unknown> }> = []
    const capture = Logger.make(({ cause, fiber, logLevel }) => {
      if (logLevel === 'Error') logged.push({ cause: Cause.pretty(cause), annotations: fiber.getRef(References.CurrentLogAnnotations) })
    })
    return Effect.gen(function* () {
      const { ipcMain, invoke } = fakeIpcMain()
      yield* handle(ipcMain, {
        channel: 'command',
        payload: Schema.String,
        handler: () => Effect.die(new Error('handler bug')),
        invalid: () => null,
      })
      const result = yield* Effect.promise(() => invoke('command', 'go').then(() => 'resolved', () => 'rejected'))
      expect(result).toBe('rejected')
      expect(logged).toEqual([
        { cause: expect.stringContaining('handler bug'), annotations: { reportId: expect.stringMatching(/^[0-9a-f]{8}$/) } },
      ])
    }).pipe(Effect.scoped, Effect.provide(Logger.layer([capture])))
  })
})
