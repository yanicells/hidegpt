/// <reference types="electron-vite/node" />
import { app, BrowserWindow, ipcMain, protocol } from 'electron'

import type { Command } from '../shared/api'
import { initCommands, runCommand } from './commands'
import { initMenu, updateMenuForSnapshot } from './menu'
import { activeSession, closeSessions, getCodexSession, initProviders, sendSnapshot, setProvider } from './providers'
import { captureScreenshots, createWindow, getWindow, registerDocsProtocol } from './window'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'docs',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

function prependPath() {
  if (process.platform !== 'darwin') return
  const home = process.env.HOME ?? ''
  const extras = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    home ? `${home}/.bun/bin` : '',
    home ? `${home}/.local/bin` : '',
  ].filter(Boolean)
  process.env.PATH = `${extras.join(':')}:${process.env.PATH ?? ''}`
}

prependPath()

app.setName('Docs')

initProviders({ getWindow, onChanged: updateMenuForSnapshot })
initCommands({ getWindow, getSession: activeSession, setProvider })
initMenu({
  getSnapshot: () => activeSession().getSnapshot(),
  dispatch: (command: Command) => void runCommand(command),
  getWindow,
})

app.whenReady().then(async () => {
  registerDocsProtocol()
  ipcMain.handle('command', async (_event, command: Command) => {
    await runCommand(command)
  })
  getCodexSession().subscribe(sendSnapshot)
  const win = createWindow({ onDidFinishLoad: sendSnapshot })
  try {
    await getCodexSession().start()
    await captureScreenshots(win, getCodexSession())
  } catch (error) {
    console.error(error)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow({ onDidFinishLoad: sendSnapshot })
})

app.on('before-quit', () => {
  closeSessions()
})
