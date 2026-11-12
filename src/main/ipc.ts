// Adapted from T3 Code (apps/desktop/src/ipc/DesktopIpc.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import type { InvokeInput, InvokePayload, InvokeResult } from '../shared/api'
import { IpcInvoke, type IpcInvokeSpec } from '../shared/contracts'

/** The part of Electron's `ipcMain` these helpers use, so tests can pass a fake. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, raw: unknown) => unknown): void
  removeHandler(channel: string): void
  on(channel: string, listener: (event: IpcMainEvent) => void): void
  removeAllListeners(channel: string): void
}

/**
 * Whether a message came from a page main trusts. `ipcMain` hears every
 * webContents and frame (an iframe a document embeds, say), so each channel
 * asks this first (T3 Code's `isTrustedSender` guard).
 */
export type SenderGuard = (event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>) => boolean

type Invoke = typeof IpcInvoke

/** One handler per `IpcInvoke` row: the decoded payload in, the row's result out. */
export type InvokeHandlers<R> = {
  readonly [K in keyof Invoke]: (input: InvokeInput<K>, event: IpcMainInvokeEvent) => Effect.Effect<InvokeResult<K>, never, R>
}

// The table seen through its own key: for a generic K, `rows[K]` and
// `handlers[K]` then name the same row, so they line up without casts.
const rows: { readonly [K in keyof Invoke]: IpcInvokeSpec<InvokeInput<K>, InvokePayload<K>, InvokeResult<K>> } = IpcInvoke

/**
 * The IPC registrations, each scoped: closing the Scope removes them. Every
 * message is checked with `isTrusted` first (T3 Code's `DesktopIpc.make`).
 */
export const makeIpc = (ipcMain: IpcMainLike, isTrusted: SenderGuard) => {
  /**
   * Answers one invoke channel. The payload is decoded before the handler
   * runs and the handler's answer is encoded with the row's `result` (which
   * drops any field it does not list), as in T3 Code's `makeIpcMethod`. An
   * untrusted sender, a payload that does not decode, or an answer that does
   * not encode all get the row's `invalid` answer.
   */
  const handle = <Payload, PayloadEncoded, Result, R>(
    spec: IpcInvokeSpec<Payload, PayloadEncoded, Result>,
    handler: (input: Payload, event: IpcMainInvokeEvent) => Effect.Effect<Result, never, R>,
  ): Effect.Effect<void, never, R | Scope.Scope> =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>()
      const runPromise = Effect.runPromiseWith(context)
      const decode = Schema.decodeUnknownEffect(spec.payload)
      const encode = Schema.encodeEffect(spec.result)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          ipcMain.removeHandler(spec.channel)
          ipcMain.handle(spec.channel, (event, raw) =>
            isTrusted(event)
              ? runPromise(
                  decode(raw).pipe(
                    Effect.flatMap((input) => handler(input, event)),
                    Effect.flatMap(encode),
                    Effect.orElseSucceed(() => spec.invalid),
                  ),
                )
              : spec.invalid,
          )
        }),
        () => Effect.sync(() => ipcMain.removeHandler(spec.channel)),
      )
    })

  /**
   * Answers every `IpcInvoke` row. `handlers` must name each one, so a row
   * without a handler fails typecheck instead of leaving a channel unanswered.
   */
  const handleAll = <R>(handlers: InvokeHandlers<R>): Effect.Effect<void, never, R | Scope.Scope> => {
    const register = <K extends keyof Invoke>(key: K) => handle(rows[key], handlers[key])
    return Effect.forEach(Object.keys(rows) as Array<keyof Invoke>, register, { discard: true })
  }

  /**
   * Answers a synchronous channel (`ipcRenderer.sendSync`) with `read()`, or
   * with `invalid` for an untrusted sender (T3 Code's `DesktopIpc.handleSync`).
   * The renderer blocks until it returns, so `read` must be cheap and must not
   * throw. Its answer is not encoded: the only sync read is the whole snapshot,
   * built by main from typed state, and encoding it would walk every block
   * while the page waits. Snapshot patches skip encoding for the same reason.
   */
  const handleSync = <Result>(
    spec: { readonly channel: string; readonly result: Schema.Codec<Result>; readonly invalid: Result },
    read: () => Result,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => {
        ipcMain.removeAllListeners(spec.channel)
        ipcMain.on(spec.channel, (event) => {
          event.returnValue = isTrusted(event) ? read() : spec.invalid
        })
      }),
      () => Effect.sync(() => ipcMain.removeAllListeners(spec.channel)),
    ).pipe(Effect.asVoid)

  return { handle, handleAll, handleSync }
}
