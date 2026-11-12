// Adapted from T3 Code (apps/desktop/src/ipc/DesktopIpc.ts) at commit 8a14762c.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import { logDefects } from '../provider/DefectReport'

/**
 * One invoke channel: its payload schema and an Effect handler. The payload
 * is decoded before the handler runs, so nothing the renderer sends reaches
 * main unchecked. Registration lives in a Scope; closing it removes the
 * handler (T3 Code's `DesktopIpc.handle`, without the tracing).
 */
export interface IpcMethod<A, I, R> {
  readonly channel: string
  readonly payload: Schema.Codec<A, I>
  /** Runs when the payload decodes; its value is the invoke result. */
  readonly handler: (input: A, event: IpcMainInvokeEvent) => Effect.Effect<unknown, never, R>
  /** The result when the payload does not decode. */
  readonly invalid: (error: Schema.SchemaError) => unknown
}

export const handle = <A, I, R>(ipcMain: IpcMain, method: IpcMethod<A, I, R>): Effect.Effect<void, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const runPromise = Effect.runPromiseWith(context)
    const decode = Schema.decodeUnknownEffect(method.payload)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        ipcMain.removeHandler(method.channel)
        ipcMain.handle(method.channel, (event, raw) =>
          runPromise(
            decode(raw).pipe(
              Effect.matchEffect({
                onFailure: (error) => Effect.succeed(method.invalid(error)),
                onSuccess: (input) => method.handler(input, event),
              }),
              // The rejection goes to the renderer, which cannot log it; log the defect here.
              logDefects,
            ),
          ),
        )
      }),
      () => Effect.sync(() => ipcMain.removeHandler(method.channel)),
    )
  })
