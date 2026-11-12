/// <reference types="electron-vite/node" />
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import {
  type Command,
  type CommandResult,
  IpcEvents,
  IpcInvoke,
  IpcSnapshotNow,
  type MenuAction,
  type SaveImageResult,
} from '../shared/contracts'
import type { ProviderId } from '../shared/model'
import { describeFailure } from '../provider/DefectReport'
import * as ProcessSupervisor from '../provider/ProcessSupervisor'
import * as Demo from './demo'
import { handle, handleSync } from './ipc'
import * as Logging from './logging/Logger'
import * as ProviderEventLog from './logging/ProviderEventLog'
import { launchPath } from './loginShellPath'
import { makeMenu } from './menu'
import * as ProviderRegistry from './ProviderRegistry'
import { ProviderSessionManager, layer as managerLayer } from './ProviderSessionManager'
import { captureScreenshots } from './screenshots'
import { makeSnapshotPublisher } from './SnapshotPublisher'
import { createWindow, documentHasImage, getWindow, openExternal, registerDocsProtocol, saveImage } from './window'

// A closed terminal must not crash main through console writes (EPIPE), as in T3 Code's desktop main.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'docs',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

// GUI apps on macOS start with a bare PATH; find the provider CLIs the way a terminal would.
if (process.platform === 'darwin') process.env.PATH = launchPath(process.env, app.isPackaged)

const demo = process.env.HIDEGPT_FAKE === '1'
/** Where a quit is: `waiting` while scopes close and providers stop, then `allowed` for the real quit. */
let quitPhase: 'running' | 'waiting' | 'allowed' = 'running'
/** The code Docs exits with once shutdown ends; a failed screenshot walk sets 1. */
let exitCode = 0

// One app per profile: a second one would share the process ledger. The lock is taken before
// the runtime exists, so a second instance builds nothing, forks no program and just quits
// (bottom of this file); the first one focuses its window. Demo mode keeps no ledger, so
// `pnpm screenshot` still runs beside the real app.
// Adapted from T3 Code (apps/desktop/src/app/DesktopClerk.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
const primary = demo || app.requestSingleInstanceLock()
/** Set once the program has a window; until then a second launch is remembered, not lost. */
let focusWindow: (() => void) | null = null
let focusPending = false
app.on('second-instance', () => {
  if (focusWindow) focusWindow()
  else focusPending = true
})
const home = () => process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
// Codex files a new document without a folder under its own threads directory.
const defaultCwd = (id: ProviderId) => (id === 'codex' ? `${home()}/.codex/threads` : home())

/** `userData/logs`: main.ndjson, and providers/<library>.ndjson. Help → Report a problem… opens it. */
const logsDirectory = join(app.getPath('userData'), 'logs')

const MainLayer = managerLayer({
  defaultCwd,
  openExternal: (url) => Effect.sync(() => openExternal(url)),
}).pipe(
  Layer.provideMerge(demo ? Demo.layer : ProviderRegistry.layer),
  Layer.provideMerge(ProcessSupervisor.layer(demo ? null : join(app.getPath('userData'), 'provider-processes.json'))),
  Layer.provideMerge(ProviderEventLog.layer(join(logsDirectory, 'providers'))),
  Layer.provideMerge(Logging.layer({ directory: logsDirectory, console: !app.isPackaged })),
  Layer.provideMerge(NodeServices.layer),
)
const runtime = ManagedRuntime.make(MainLayer)

/** The app: IPC, the window, the menu, and the first library's connection. Runs until quit. */
const program = Effect.gen(function* () {
  yield* Effect.promise(() => app.whenReady())
  yield* Effect.logInfo('Docs started', { version: app.getVersion(), demo })
  const supervisor = yield* ProcessSupervisor.ProcessSupervisor
  const reaped = yield* supervisor.reapOrphans
  if (reaped > 0) yield* Effect.logWarning(`Stopped ${reaped} provider process(es) left by the last run.`)
  const manager = yield* ProviderSessionManager

  const sendMenu = (action: MenuAction) => getWindow()?.webContents.send(IpcEvents.onMenu.channel, action)

  /**
   * Every command, from the window or the menu, ends in a result; nothing is thrown away.
   * A defect's raw text never reaches the page: it is logged, and the page gets a plain sentence.
   */
  const run = (command: Command): Effect.Effect<CommandResult> =>
    (command.op === 'openFolder' ? openFolder : manager.dispatch(command)).pipe(
      Effect.as<CommandResult>({ ok: true }),
      Effect.catchCause((cause) =>
        Effect.map(describeFailure(cause), (error): CommandResult => ({ ok: false, error })),
      ),
      Effect.annotateLogs({ command: command.op }),
    )

  const openFolder = Effect.gen(function* () {
    const win = getWindow()
    if (!win) return
    const current = yield* manager.snapshot
    const picked = yield* Effect.promise(() =>
      dialog.showOpenDialog(win, {
        title: 'Open folder',
        properties: ['openDirectory'],
        defaultPath: current.cwd || undefined,
      }),
    )
    const folder = picked.canceled ? undefined : picked.filePaths[0]
    if (folder) yield* manager.setFolder(folder)
  })

  // Menu commands have no caller to show an error to, so a failure lands on the banner.
  const dispatchFromMenu = (command: Command) =>
    runtime.runFork(
      run(command).pipe(Effect.flatMap((result) => (result.ok ? Effect.void : manager.notify(result.error)))),
    )
  const updateMenu = makeMenu({
    dispatch: dispatchFromMenu,
    send: sendMenu,
    // openPath resolves to an error message when it fails (say, the folder is gone); show Docs' own folder then.
    reportProblem: () =>
      void shell.openPath(logsDirectory).then((failed) => {
        if (failed) shell.showItemInFolder(app.getPath('userData'))
      }),
  })

  yield* handle(ipcMain, IpcInvoke.dispatch, run)
  yield* handle(ipcMain, IpcInvoke.pickDirectory, () =>
    Effect.promise(async () => {
      const win = getWindow()
      if (!win) return null
      const picked = await dialog.showOpenDialog(win, {
        title: 'Choose project folder',
        properties: ['openDirectory', 'createDirectory'],
      })
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    }),
  )
  yield* handle(ipcMain, IpcInvoke.saveImage, ({ bytes, mime }) =>
    Effect.tryPromise(() => saveImage(bytes, mime)).pipe(
      Effect.map((path): SaveImageResult => ({ ok: true, path })),
      Effect.catchCause((cause) =>
        Effect.map(describeFailure(cause), (error): SaveImageResult => ({ ok: false, error })),
      ),
    ),
  )

  const publisher = makeSnapshotPublisher(manager.snapshots, (patch, snapshot) => {
    const win = getWindow()
    win?.setTitle(snapshot.route.kind === 'home' ? 'Docs' : snapshot.title || 'Docs')
    win?.webContents.send(IpcEvents.onSnapshot.channel, patch)
    updateMenu(snapshot)
  })
  yield* Effect.forkScoped(publisher.run)
  // The preload asks synchronously before the first paint, so this must exist before any window.
  yield* handleSync(ipcMain, IpcSnapshotNow, publisher.delivered)

  // Local images load only if the window was handed them: the open document's, or pasted ones.
  registerDocsProtocol((ref) => documentHasImage(publisher.delivered()?.snapshot ?? null, ref))

  const open = () => createWindow({ onDidFinishLoad: publisher.resync })
  const win = open()
  // While a quit waits on shutdown, activation opens nothing (T3 Code's DesktopLifecycle).
  app.on('activate', () => {
    if (quitPhase === 'running' && BrowserWindow.getAllWindows().length === 0) open()
  })
  focusWindow = () => {
    if (quitPhase !== 'running') return
    const current = getWindow()
    if (!current) return void open()
    if (current.isMinimized()) current.restore()
    current.focus()
  }
  if (focusPending) focusWindow()

  yield* manager.start('codex')
  const shots = process.env.HIDEGPT_SCREENSHOT
  // The walk drives the demo library; against real providers it would open real documents.
  if (shots && !demo) console.error('HIDEGPT_SCREENSHOT needs HIDEGPT_FAKE=1; skipping screenshots.')
  if (shots && demo) {
    // A failed step still quits, with the reason on stderr, so a run never hangs.
    yield* captureScreenshots(win, manager, publisher.stage, shots).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error('Screenshots failed:', cause)
          exitCode = 1
        }),
      ),
    )
    app.quit()
  }
  return yield* Effect.never
}).pipe(Effect.scoped)

// A second instance quits here, before ready: no runtime, no program, nothing to shut down.
if (!primary) app.quit()
const main = primary ? runtime.runFork(program) : null
// The app cannot run without its program; whenever it fails, say why, in the log too.
main?.addObserver((exit) => {
  if (exit._tag === 'Success' || Cause.hasInterruptsOnly(exit.cause)) return
  console.error(exit.cause)
  runtime.runFork(Effect.logFatal('Docs stopped', exit.cause))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Adapted from T3 Code (apps/desktop/src/app/DesktopLifecycle.ts) at commit 8a14762c.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
/** A shutdown that takes longer than this exits anyway; the ledger reaps leftovers next start. */
const SHUTDOWN_DEADLINE_MS = 5_000

// Quitting closes every scope first, so provider processes get SIGTERM (then SIGKILL)
// before Electron exits: the first before-quit is cancelled, shutdown runs, then the
// app quits for real. (Cancelling will-quit instead leaves macOS unable to quit again.)
app.on('before-quit', (event) => {
  if (quitPhase === 'allowed' || !main) return
  event.preventDefault()
  if (quitPhase === 'waiting') return
  quitPhase = 'waiting'
  const stalled = setTimeout(() => {
    console.error('Docs did not shut down in time; exiting without it.')
    app.exit(exitCode)
  }, SHUTDOWN_DEADLINE_MS)
  void runtime
    .runPromise(Fiber.interrupt(main))
    .then(() => runtime.dispose())
    .catch((error: unknown) => console.error(error))
    .finally(() => {
      clearTimeout(stalled)
      quitPhase = 'allowed'
      // Electron ignores process.exitCode, so a failed run exits explicitly; a normal
      // quit goes through app.quit so windows still close the usual way.
      if (exitCode === 0) app.quit()
      else app.exit(exitCode)
    })
})
