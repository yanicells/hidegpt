import type { IpcEvents, IpcInvoke, Snapshot } from './contracts'

export type {
  Command,
  CommandResult,
  MenuAction,
  PickDirectoryResult,
  SaveImageRequest,
  SaveImageResult,
  SnapshotPatch,
} from './contracts'

type Invoke = typeof IpcInvoke
type Events = typeof IpcEvents

/** What the renderer sends on an invoke channel (main decodes it). */
export type InvokePayload<K extends keyof Invoke> = Invoke[K]['payload']['Encoded']
/** What main answers on an invoke channel. */
export type InvokeResult<K extends keyof Invoke> = Invoke[K]['result']['Type']
/** What main pushes on an event channel. */
export type EventValue<K extends keyof Events> = Events[K]['value']['Type']

/** One method per `IpcInvoke` row; a channel without a payload takes no argument. */
type InvokeMethods = {
  readonly [K in keyof Invoke]: InvokePayload<K> extends undefined
    ? () => Promise<InvokeResult<K>>
    : (payload: InvokePayload<K>) => Promise<InvokeResult<K>>
}

/** One subscriber per `IpcEvents` row; each returns its unsubscribe. */
type EventMethods = {
  readonly [K in keyof Events]: (handler: (value: EventValue<K>) => void) => () => void
}

/**
 * The `window.hidegpt` bridge the preload exposes, derived from the IPC tables
 * in `./contracts`: `dispatch`, `pickDirectory` and `saveImage` invoke main,
 * `onSnapshot` and `onMenu` subscribe to its pushes.
 */
export type HideGptApi = InvokeMethods &
  EventMethods & {
    /**
     * The whole current snapshot. Read it once at startup and apply every
     * `onSnapshot` patch from then on; the preload keeps no copy after this read.
     */
    readonly getSnapshot: () => Snapshot
    readonly platform: NodeJS.Platform
  }

declare global {
  interface Window {
    hidegpt: HideGptApi
  }
}
