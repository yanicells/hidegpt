// Adapted from T3 Code (apps/desktop/src/ipc/DesktopIpc.test.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { IpcInvoke, IpcSnapshotNow, MAX_IMAGE_BYTES, type SaveImageResult } from '../shared/contracts'
import { emptySnapshot } from '../shared/model'
import { type IpcMainLike, makeIpc } from './ipc'

const APP = 1
const OTHER = 2

/**
 * An `ipcMain` that keeps its listeners in maps, so a test can call them. The
 * guard trusts webContents `APP`; `call` and `readSync` say which one sends.
 */
function fakeIpc() {
  const invoke = new Map<string, (event: IpcMainInvokeEvent, raw: unknown) => unknown>()
  const sync = new Map<string, (event: IpcMainEvent) => void>()
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void invoke.set(channel, listener),
    removeHandler: (channel) => void invoke.delete(channel),
    on: (channel, listener) => void sync.set(channel, listener),
    removeAllListeners: (channel) => void sync.delete(channel),
  }
  const ipc = makeIpc(ipcMain, (event) => event.sender.id === APP)
  // Only `sender.id` (and `returnValue` for a sync read) is used.
  const call = (channel: string, raw: unknown, sender = APP) =>
    Effect.promise(async () => invoke.get(channel)?.({ sender: { id: sender } } as IpcMainInvokeEvent, raw))
  const readSync = (channel: string, sender = APP) => {
    const event = { sender: { id: sender }, returnValue: undefined } as IpcMainEvent
    sync.get(channel)?.(event)
    return event.returnValue
  }
  return { ipc, invoke, sync, call, readSync }
}

describe('ipc', () => {
  it.effect("answers each row's invalid value for a payload that does not decode or a sender it does not trust", () =>
    Effect.gen(function* () {
      const { ipc, call } = fakeIpc()
      const ran: string[] = []
      const recorded =
        <A>(name: string, answer: A) =>
        () =>
          Effect.sync(() => {
            ran.push(name)
            return answer
          })
      yield* ipc.handleAll({
        dispatch: recorded('dispatch', { ok: true }),
        pickDirectory: recorded('pickDirectory', '/picked'),
        saveImage: recorded('saveImage', { ok: true, path: '/a.png' }),
      })

      for (const spec of Object.values(IpcInvoke)) {
        const answer = yield* call(spec.channel, { op: 'no-such-command', bytes: 'not bytes' })
        expect(answer).toEqual(spec.invalid)
        // The fallback is itself a valid answer for the channel.
        expect(Schema.is(spec.result)(answer)).toBe(true)
      }
      // A well-formed request from another webContents (or a frame inside the window) is refused too.
      expect(yield* call(IpcInvoke.pickDirectory.channel, undefined, OTHER)).toEqual(IpcInvoke.pickDirectory.invalid)
      // An image over the cap, or of a type Docs cannot store, never reaches the handler.
      const saveImage = IpcInvoke.saveImage
      expect(yield* call(saveImage.channel, { bytes: new Uint8Array(MAX_IMAGE_BYTES + 1), mime: 'image/png' })).toEqual(
        saveImage.invalid,
      )
      expect(yield* call(saveImage.channel, { bytes: new Uint8Array([1]), mime: 'image/svg+xml' })).toEqual(saveImage.invalid)
      expect(ran).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.effect('runs the handler with the decoded payload, encodes its answer, and unregisters when the scope closes', () =>
    Effect.gen(function* () {
      const { ipc, invoke, call } = fakeIpc()
      const saved: Array<{ bytes: Uint8Array; mime: string }> = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handle(IpcInvoke.saveImage, (request) =>
            Effect.sync(() => {
              saved.push(request)
              // A field the result does not list stays in main.
              const answer = { ok: true as const, path: '/a.png', tempFile: '/tmp/x' }
              return answer satisfies SaveImageResult
            }),
          )
          const bytes = new Uint8Array([1, 2, 3])
          expect(yield* call(IpcInvoke.saveImage.channel, { bytes, mime: 'image/png' })).toStrictEqual({ ok: true, path: '/a.png' })
          expect(saved).toEqual([{ bytes, mime: 'image/png' }])
        }),
      )
      expect(invoke.size).toBe(0)
    }),
  )

  it.effect('answers a sync read while the scope is open, and null to an untrusted sender', () =>
    Effect.gen(function* () {
      const { ipc, sync, readSync } = fakeIpc()
      const snapshot = { snapshot: emptySnapshot('/docs'), seq: 3 }
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handleSync(IpcSnapshotNow, () => snapshot)
          expect(readSync(IpcSnapshotNow.channel)).toBe(snapshot)
          expect(readSync(IpcSnapshotNow.channel, OTHER)).toBeNull()
        }),
      )
      expect(sync.size).toBe(0)
    }),
  )
})
