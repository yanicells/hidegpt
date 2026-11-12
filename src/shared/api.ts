import type { IpcEvents, IpcInvoke, SequencedSnapshot } from './contracts'

export type {
  Command,
  CommandResult,
  MenuAction,
  PickDirectoryResult,
  SequencedSnapshot,
  SaveImageRequest,
  SaveImageResult,
  SnapshotPatch,
} from './contracts'

type Invoke = typeof IpcInvoke
type Events = typeof IpcEvents

/** What the renderer sends on an invoke channel (main decodes it). */
export type InvokePayload<K extends keyof Invoke> = Invoke[K]['payload']['Encoded']
/** What main's handler receives once the payload is decoded. */
export type InvokeInput<K extends keyof Invoke> = Invoke[K]['payload']['Type']
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
     * The whole current snapshot and the `seq` of the last patch in it. Apply
     * every later `onSnapshot` patch with `applyPatchOnce`, which skips the ones
     * it already includes. The preload keeps no copy after the first read.
     */
    readonly getSnapshot: () => SequencedSnapshot
    readonly platform: NodeJS.Platform
  }

type ApiMethod = {
  [K in keyof HideGptApi]: HideGptApi[K] extends (...args: never) => unknown ? K : never
}[keyof HideGptApi]

// A record, so the compiler rejects a method missing from the list as well as an extra one.
const methods: Record<ApiMethod, true> = {
  getSnapshot: true,
  onSnapshot: true,
  onMenu: true,
  dispatch: true,
  pickDirectory: true,
  saveImage: true,
}

/** Every function on `window.hidegpt`; `pnpm dist` checks the built preload exposes them all. */
export const HIDEGPT_API_METHODS = Object.keys(methods) as ReadonlyArray<ApiMethod>

declare global {
  interface Window {
    hidegpt: HideGptApi
  }
}
