/// <reference types="electron-vite/node" />
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import {
  type Command,
  type CommandResult,
  IpcEvents,
  IpcSnapshotNow,
  type MenuAction,
  type SaveImageResult,
} from '../shared/contracts'
import type { ProviderId } from '../shared/model'
import { describeFailure } from '../provider/DefectReport'
import { forkObserved, makeRunObserved } from '../provider/observed'
import * as ProcessSupervisor from '../provider/ProcessSupervisor'
import * as Demo from './demo'
import { makeIpc, type SenderGuard } from './ipc'
import { makeLifecycle, makeSyncLog } from './lifecycle'
import * as Logging from './logging/Logger'
import { makeRedactor } from './logging/redact'
import * as ProviderEventLog from './logging/ProviderEventLog'
import { hydratePath, killLoginShellProbe } from './loginShellPath'
import { makeMenu } from './menu'
import * as ProviderRegistry from './ProviderRegistry'
import { ProviderSessionManager, layer as managerLayer } from './ProviderSessionManager'
import { captureScreenshots } from './screenshots'
import { makeSnapshotPublisher, reportingThrows } from './SnapshotPublisher'
import {
  createWindow,
  documentHasImage,
  getWindow,
  openExternal,
  registerDocsProtocol,
  saveImage,
  type WindowWarn,
} from './window'

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

// GUI apps on macOS start with a bare PATH; find the provider CLIs the way a terminal
// would. The login-shell lookup runs while the window paints; providers wait for it.
const pathReady = process.platform === 'darwin' ? hydratePath(process.env, app.isPackaged) : Promise.resolve()
app.on('will-quit', killLoginShellProbe)

const demo = process.env.HIDEGPT_FAKE === '1'
/** Where a quit is: `waiting` while scopes close and providers stop, then `allowed` for the real quit. */
let quitPhase: 'running' | 'waiting' | 'allowed' = 'running'
/** The code Docs exits with once shutdown ends; a failed start or screenshot walk sets 1. */
let exitCode = 0
/** The provider process groups still running; the supervisor's list once the program has it. */
let livePids: () => ReadonlyArray<number> = () => []

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
  Layer.provideMerge(demo ? Demo.layer : ProviderRegistry.layerAfter(pathReady)),
  Layer.provideMerge(ProcessSupervisor.layer(demo ? null : join(app.getPath('userData'), 'provider-processes.json'))),
  Layer.provideMerge(ProviderEventLog.layer(join(logsDirectory, 'providers'))),
  Layer.provideMerge(Logging.layer({ directory: logsDirectory, console: !app.isPackaged })),
  Layer.provideMerge(NodeServices.layer),
)
const runtime = ManagedRuntime.make(MainLayer)

/**
 * Runs `effect` on main's runtime from outside any fiber, for the lifecycle's log lines,
 * which outlive the program's scope. Resolves whether it succeeded; never rejects.
 */
const runOnMain = (effect: Effect.Effect<void>) =>
  new Promise<boolean>((resolve) => {
    try {
      // oxlint-disable-next-line hidegpt/no-unobserved-effect -- its exit is awaited; a failure falls back to the sync log
      runtime.runFork(effect).addObserver((exit) => resolve(Exit.isSuccess(exit)))
    } catch {
      // A disposed runtime: the caller writes straight to the file.
      resolve(false)
    }
  })

// A failed start says so and quits; a throw outside any fiber is reported, not shown in
// Electron's dialog; a quit that runs out of time kills what is left by pid.
const lifecycle = makeLifecycle({
  run: runOnMain,
  logSync: makeSyncLog(logsDirectory, makeRedactor(Logging.thisMachine())),
  // A screenshot run must end, not wait on a box nobody will click.
  showErrorBox: process.env.HIDEGPT_SCREENSHOT ? null : (title, content) => dialog.showErrorBox(title, content),
  setExitCode: (code) => {
    exitCode = code
  },
  quit: () => app.quit(),
  exit: () => {
    // app.exit skips will-quit, so stop the PATH probe here too.
    killLoginShellProbe()
    app.exit(exitCode)
  },
  livePids: () => livePids(),
})
lifecycle.listen(process)

/** The app: IPC, the window, the menu, and the first library's connection. Runs until quit. */
const program = Effect.gen(function* () {
  yield* Effect.promise(() => app.whenReady())
  yield* Effect.logInfo('Docs started', { version: app.getVersion(), demo })
  const shots = process.env.HIDEGPT_SCREENSHOT
  // The walk drives the demo library; against real providers it would open real documents,
  // so a screenshot run without the fakes fails at once instead of carrying on as the real app.
  if (shots && !demo) {
    console.error('HIDEGPT_SCREENSHOT needs HIDEGPT_FAKE=1.')
    exitCode = 1
    app.quit()
    return
  }
  const supervisor = yield* ProcessSupervisor.ProcessSupervisor
  livePids = supervisor.livePidsSync
  const reaped = yield* supervisor.reapOrphans
  if (reaped > 0) yield* Effect.logWarning(`Stopped ${reaped} provider process(es) left by the last run.`)
  const manager = yield* ProviderSessionManager
  // Electron callbacks run outside any fiber; work they start runs on the program's services
  // and is interrupted when the program ends.
  const runObserved = yield* makeRunObserved()

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
    void runObserved(
      run(command).pipe(Effect.flatMap((result) => (result.ok ? Effect.void : manager.notify(result.error)))),
      { name: 'menu.dispatch' },
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

  const ipc = makeIpc(ipcMain, fromAppWindow)
  yield* ipc.handleAll({
    dispatch: run,
    pickDirectory: () =>
      Effect.promise(async () => {
        const win = getWindow()
        if (!win) return null
        const picked = await dialog.showOpenDialog(win, {
          title: 'Choose project folder',
          properties: ['openDirectory', 'createDirectory'],
        })
        return picked.canceled ? null : (picked.filePaths[0] ?? null)
      }),
    saveImage: ({ bytes, mime }) =>
      // A rejection is a defect: logged under a report id, with the generic sentence on the page.
      Effect.promise(() => saveImage(bytes, mime)).pipe(
        Effect.map((path): SaveImageResult => ({ ok: true, path })),
        Effect.catchCause((cause) =>
          Effect.map(describeFailure(cause), (error): SaveImageResult => ({ ok: false, error })),
        ),
      ),
  })

  /** Runs `part` from a callback outside any fiber; a throw is reported under its name and goes no further. */
  const guarded = (part: string, run: () => void) =>
    reportingThrows((report) => runObserved(report, { name: 'main.guarded' }), part, run)

  const publisher = makeSnapshotPublisher(manager.snapshots, (patch, snapshot) => {
    const win = getWindow()
    // The title and the menu are extras: a bug in either costs only that part, never the page.
    guarded('title', () => win?.setTitle(snapshot.route.kind === 'home' ? 'Docs' : snapshot.title || 'Docs'))
    win?.webContents.send(IpcEvents.onSnapshot.channel, patch)
    guarded('menu', () => updateMenu(snapshot))
  })
  // A defect is reported inside `run`, which then starts over; one that escapes is reported here.
  yield* forkObserved({ name: 'snapshot.publisher' })(publisher.run)
  // The preload asks synchronously before the first paint, so this must exist before any window.
  yield* ipc.handleSync(IpcSnapshotNow, publisher.delivered)

  // Local images load only if the window was handed them: the open document's, or pasted ones.
  registerDocsProtocol((ref) => documentHasImage(publisher.delivered()?.snapshot ?? null, ref))

  // Runs in an Electron event, outside any fiber. On a throw the publisher has already
  // forgotten what the window has, so its next patch is whole.
  const warn: WindowWarn = (message, fields) =>
    void runObserved(Effect.logWarning(message).pipe(Effect.annotateLogs(fields)), { name: 'window.log' })
  const open = () => createWindow({ onDidFinishLoad: () => guarded('resync', publisher.resync), warn })
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
  if (shots) {
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

// Adapted from T3 Code (apps/desktop/src/ipc/DesktopIpc.ts, layer) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
/** Only the app window's own page may call main: not another webContents, not a frame inside it. */
const fromAppWindow: SenderGuard = (event) => {
  const win = getWindow()
  return win !== null && win.webContents.id === event.sender.id && win.webContents.mainFrame === event.senderFrame
}

// A second instance quits here, before ready: no runtime, no program, nothing to shut down.
if (!primary) app.quit()
// oxlint-disable-next-line hidegpt/no-unobserved-effect -- main's entry point; its exit is observed on the next line
const main = primary ? runtime.runFork(program) : null
// The app cannot run without its program: a failure is logged, shown in a plain box, and quits.
main?.addObserver(lifecycle.programExited)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Adapted from T3 Code (apps/desktop/src/app/DesktopLifecycle.ts) at commit 8a14762c.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
// Quitting closes every scope first, so provider processes get SIGTERM (then SIGKILL)
// before Electron exits: the first before-quit is cancelled, shutdown runs, then the
// app quits for real. (Cancelling will-quit instead leaves macOS unable to quit again.)
app.on('before-quit', (event) => {
  if (quitPhase === 'allowed' || !main) return
  event.preventDefault()
  if (quitPhase === 'waiting') return
  quitPhase = 'waiting'
  // Past the deadline, lifecycle kills every provider group still listed and exits; the
  // ledger reaps anything else on the next start.
  lifecycle.shutDown(
    {
      stop: () =>
        new Promise<void>((resolve) => {
          main.addObserver(() => resolve())
          main.interruptUnsafe()
        }),
      dispose: () => runtime.dispose(),
    },
    () => {
      quitPhase = 'allowed'
      // Electron ignores process.exitCode, so a failed run exits explicitly; a normal
      // quit goes through app.quit so windows still close the usual way.
      if (exitCode === 0) return void app.quit()
      killLoginShellProbe()
      app.exit(exitCode)
    },
  )
})
