// Adapted from T3 Code (apps/desktop/src/ipc/DesktopIpc.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import type { IpcInvokeSpec } from '../shared/contracts'

/** The part of Electron's `ipcMain` these helpers use, so tests can pass a fake. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, raw: unknown) => unknown): void
  removeHandler(channel: string): void
  on(channel: string, listener: (event: IpcMainEvent) => void): void
  removeAllListeners(channel: string): void
}

/**
 * Answers one invoke channel from the `IpcInvoke` table. The payload is
 * decoded before the handler runs, so nothing the renderer sends reaches main
 * unchecked; one that does not decode gets the row's `invalid` answer. The
 * registration lives in the Scope: closing it removes the handler (T3 Code's
 * `DesktopIpc.handle` with `makeIpcMethod`, without the tracing).
 */
export const handle = <Payload, PayloadEncoded, Result, R>(
  ipcMain: IpcMainLike,
  spec: IpcInvokeSpec<Payload, PayloadEncoded, Result>,
  handler: (input: Payload, event: IpcMainInvokeEvent) => Effect.Effect<Result, never, R>,
): Effect.Effect<void, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const runPromise = Effect.runPromiseWith(context)
    const decode = Schema.decodeUnknownEffect(spec.payload)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        ipcMain.removeHandler(spec.channel)
        ipcMain.handle(spec.channel, (event, raw) =>
          runPromise(
            decode(raw).pipe(
              Effect.matchEffect({
                onFailure: () => Effect.succeed(spec.invalid),
                onSuccess: (input) => handler(input, event),
              }),
            ),
          ),
        )
      }),
      () => Effect.sync(() => ipcMain.removeHandler(spec.channel)),
    )
  })

/**
 * Answers a synchronous channel (`ipcRenderer.sendSync`) with `read()`, while
 * the Scope is open (T3 Code's `DesktopIpc.handleSync`). The renderer blocks
 * until it returns, so `read` must be cheap and must not throw.
 */
export const handleSync = <Result>(
  ipcMain: IpcMainLike,
  spec: { readonly channel: string; readonly result: Schema.Codec<Result> },
  read: () => Result,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      ipcMain.removeAllListeners(spec.channel)
      ipcMain.on(spec.channel, (event) => {
        event.returnValue = read()
      })
    }),
    () => Effect.sync(() => ipcMain.removeAllListeners(spec.channel)),
  ).pipe(Effect.asVoid)
