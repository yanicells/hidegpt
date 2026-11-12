/// <reference types="electron-vite/node" />
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Schema from 'effect/Schema'

import { Command, type CommandResult, type MenuAction } from '../shared/contracts'
import type { ProviderId } from '../shared/model'
import { describeFailure } from '../provider/DefectReport'
import * as ProcessSupervisor from '../provider/ProcessSupervisor'
import * as Demo from './demo'
import { handle } from './ipc'
import * as Logging from './logging/Logger'
import * as ProviderEventLog from './logging/ProviderEventLog'
import { makeMenu } from './menu'
import * as ProviderRegistry from './ProviderRegistry'
import { ProviderSessionManager, layer as managerLayer } from './ProviderSessionManager'
import { captureScreenshots } from './screenshots'
import { makeSnapshotPublisher } from './SnapshotPublisher'
import { createWindow, getWindow, openExternal, registerDocsProtocol, saveImage } from './window'

// A closed terminal must not crash main through console writes (EPIPE), as in T3 Code's desktop main.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'docs', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

/** GUI apps on macOS start with a bare PATH; add where the provider CLIs usually live. */
function prependPath() {
  if (process.platform !== 'darwin') return
  const home = process.env.HOME ?? ''
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', home ? `${home}/.bun/bin` : '', home ? `${home}/.local/bin` : ''].filter(Boolean)
  process.env.PATH = `${extras.join(':')}:${process.env.PATH ?? ''}`
}

prependPath()

const demo = process.env.HIDEGPT_FAKE === '1'
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
/** Where a quit is: `waiting` while scopes close and providers stop, then `allowed` for the real quit. */
let quitPhase: 'running' | 'waiting' | 'allowed' = 'running'

const decodeFailed: CommandResult = { ok: false, error: 'Docs could not read that request.' }

/** The app: IPC, the window, the menu, and the first library's connection. Runs until quit. */
const program = Effect.gen(function* () {
  yield* Effect.promise(() => app.whenReady())
  yield* Effect.logInfo('Docs started', { version: app.getVersion(), demo })
  registerDocsProtocol()
  const supervisor = yield* ProcessSupervisor.ProcessSupervisor
  const reaped = yield* supervisor.reapOrphans
  if (reaped > 0) yield* Effect.logWarning(`Stopped ${reaped} provider process(es) left by the last run.`)
  const manager = yield* ProviderSessionManager

  const send = (channel: string, value: unknown) => getWindow()?.webContents.send(channel, value)
  const sendMenu = (action: MenuAction) => send('menu', action)

  /**
   * Every command, from the window or the menu, ends in a result; nothing is thrown away.
   * A defect's raw text never reaches the page: it is logged, and the page gets a plain sentence.
   */
  const run = (command: Command): Effect.Effect<CommandResult> =>
    (command.op === 'openFolder' ? openFolder : manager.dispatch(command)).pipe(
      Effect.as<CommandResult>({ ok: true }),
      Effect.catchCause((cause) => Effect.map(describeFailure(cause), (error): CommandResult => ({ ok: false, error }))),
      Effect.annotateLogs({ command: command.op }),
    )

  const openFolder = Effect.gen(function* () {
    const win = getWindow()
    if (!win) return
    const current = yield* manager.snapshot
    const picked = yield* Effect.promise(() =>
      dialog.showOpenDialog(win, { title: 'Open folder', properties: ['openDirectory'], defaultPath: current.cwd || undefined }),
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

  yield* handle(ipcMain, {
    channel: 'command',
    payload: Command,
    handler: run,
    invalid: () => decodeFailed,
  })
  yield* handle(ipcMain, {
    channel: 'pick-directory',
    payload: Schema.Undefined,
    handler: () =>
      Effect.promise(async () => {
        const win = getWindow()
        if (!win) return null
        const picked = await dialog.showOpenDialog(win, {
          title: 'Choose project folder',
          properties: ['openDirectory', 'createDirectory'],
        })
        return picked.canceled ? null : (picked.filePaths[0] ?? null)
      }),
    invalid: () => null,
  })
  yield* handle(ipcMain, {
    channel: 'save-image',
    payload: Schema.Tuple([Schema.Uint8Array, Schema.String]),
    handler: ([bytes, mime]) =>
      Effect.tryPromise(() => saveImage(bytes, mime)).pipe(
        Effect.map((path): { ok: true; path: string } | { ok: false; error: string } => ({ ok: true, path })),
        Effect.catchCause((cause) => Effect.map(describeFailure(cause), (error) => ({ ok: false as const, error }))),
      ),
    invalid: () => ({ ok: false, error: 'Docs could not read that image.' }),
  })

  const publisher = makeSnapshotPublisher(manager.snapshots, (patch, snapshot) => {
    const win = getWindow()
    win?.setTitle(snapshot.route.kind === 'home' ? 'Docs' : snapshot.title || 'Docs')
    win?.webContents.send('snapshot', patch)
    updateMenu(snapshot)
  })
  // A defect is reported inside `run`, which then starts over.
  yield* Effect.forkScoped(publisher.run)
  // The preload asks synchronously before the first paint, so this must exist before any window.
  ipcMain.on('snapshot-now', (event) => {
    event.returnValue = publisher.delivered()
  })

  const open = () => createWindow({ onDidFinishLoad: publisher.resync })
  const win = open()
  // While a quit waits on shutdown, activation opens nothing (T3 Code's DesktopLifecycle).
  app.on('activate', () => {
    if (quitPhase === 'running' && BrowserWindow.getAllWindows().length === 0) open()
  })

  yield* manager.start('codex')
  const shots = process.env.HIDEGPT_SCREENSHOT
  if (shots) {
    yield* captureScreenshots(win, manager, shots)
    app.quit()
  }
  return yield* Effect.never
}).pipe(Effect.scoped)

const main = runtime.runFork(program)
// The app cannot run without its program; whenever it fails, say why, in the log too.
main.addObserver((exit) => {
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
  if (quitPhase === 'allowed') return
  event.preventDefault()
  if (quitPhase === 'waiting') return
  quitPhase = 'waiting'
  const stalled = setTimeout(() => {
    console.error('Docs did not shut down in time; exiting without it.')
    app.exit(0)
  }, SHUTDOWN_DEADLINE_MS)
  void runtime
    .runPromise(Fiber.interrupt(main))
    .then(() => runtime.dispose())
    .catch((error: unknown) => console.error(error))
    .finally(() => {
      clearTimeout(stalled)
      quitPhase = 'allowed'
      app.quit()
    })
})
