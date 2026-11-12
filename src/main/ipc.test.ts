// Adapted from T3 Code (apps/desktop/src/ipc/DesktopIpc.test.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { IpcInvoke, IpcSnapshotNow } from '../shared/contracts'
import { emptySnapshot } from '../shared/model'
import { handle, handleSync, type IpcMainLike } from './ipc'

/** An `ipcMain` that keeps its listeners in maps, so a test can call them. */
function fakeIpcMain() {
  const invoke = new Map<string, (event: IpcMainInvokeEvent, raw: unknown) => unknown>()
  const sync = new Map<string, (event: IpcMainEvent) => void>()
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void invoke.set(channel, listener),
    removeHandler: (channel) => void invoke.delete(channel),
    on: (channel, listener) => void sync.set(channel, listener),
    removeAllListeners: (channel) => void sync.delete(channel),
  }
  // The handlers under test never read the event.
  const event = {} as IpcMainInvokeEvent
  const call = (channel: string, raw: unknown) => Effect.promise(async () => invoke.get(channel)?.(event, raw))
  return { ipcMain, invoke, sync, call }
}

describe('ipc', () => {
  it.effect("answers each channel's invalid value when the payload does not decode", () =>
    Effect.gen(function* () {
      const { ipcMain, call } = fakeIpcMain()
      const ran: string[] = []
      const recorded =
        <A>(name: string, answer: A) =>
        () =>
          Effect.sync(() => {
            ran.push(name)
            return answer
          })
      yield* handle(ipcMain, IpcInvoke.dispatch, recorded('dispatch', { ok: true }))
      yield* handle(ipcMain, IpcInvoke.pickDirectory, recorded('pickDirectory', '/picked'))
      yield* handle(ipcMain, IpcInvoke.saveImage, recorded('saveImage', { ok: true, path: '/a.png' }))

      for (const spec of Object.values(IpcInvoke)) {
        const answer = yield* call(spec.channel, { op: 'no-such-command', bytes: 'not bytes' })
        expect(answer).toEqual(spec.invalid)
        // The fallback is itself a valid answer for the channel.
        expect(Schema.is(spec.result)(answer)).toBe(true)
      }
      expect(ran).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.effect('runs the handler with the decoded payload, and unregisters when the scope closes', () =>
    Effect.gen(function* () {
      const { ipcMain, invoke, call } = fakeIpcMain()
      const saved: Array<{ bytes: Uint8Array; mime: string }> = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* handle(ipcMain, IpcInvoke.saveImage, (request) =>
            Effect.sync(() => {
              saved.push(request)
              return { ok: true as const, path: '/a.png' }
            }),
          )
          const bytes = new Uint8Array([1, 2, 3])
          expect(yield* call(IpcInvoke.saveImage.channel, { bytes, mime: 'image/png' })).toEqual({
            ok: true,
            path: '/a.png',
          })
          expect(saved).toEqual([{ bytes, mime: 'image/png' }])
        }),
      )
      expect(invoke.size).toBe(0)
    }),
  )

  it.effect('answers a sync read while the scope is open', () =>
    Effect.gen(function* () {
      const { ipcMain, sync } = fakeIpcMain()
      const snapshot = { snapshot: emptySnapshot('/docs'), seq: 3 }
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* handleSync(ipcMain, IpcSnapshotNow, () => snapshot)
          // Only `returnValue` is read back.
          const event = { returnValue: undefined } as IpcMainEvent
          sync.get(IpcSnapshotNow.channel)?.(event)
          expect(event.returnValue).toBe(snapshot)
        }),
      )
      expect(sync.size).toBe(0)
    }),
  )
})
