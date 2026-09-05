import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'

import type { CodexSession } from '../codex/session'
import type { Provider } from '../codex/types'
import type { OpenCodeSession } from '../opencode/session'
import type { Command } from '../shared/api'

export type CommandContext = {
  getWindow: () => BrowserWindow | null
  getSession: () => CodexSession | OpenCodeSession
  setProvider: (next: Provider) => Promise<void>
}

let context: CommandContext | null = null

/** Wire window/session collaborators so menu and IPC share this one path. */
export function initCommands(next: CommandContext): void {
  context = next
}

function deps(): CommandContext {
  if (!context) throw new Error('commands not initialized')
  return context
}

export async function runCommand(command: Command): Promise<void> {
  const { getSession, setProvider } = deps()
  if (command.op === 'setProvider') {
    await setProvider(command.provider)
    return
  }
  const session = getSession()
  switch (command.op) {
    case 'newDocument':
      await session.newDocument(command)
      if (session.snapshot.route.kind !== 'doc') throw new Error(session.snapshot.error ?? 'Could not create document')
      return
    case 'createProject':
      await session.createProject(command.name, command.cwd)
      return
    case 'openThread':
      await session.openThread(command.threadId)
      return
    case 'goHome':
      session.goHome()
      return
    case 'send':
      await session.send(command.text)
      return
    case 'interrupt':
      await session.interrupt()
      return
    case 'login':
      await session.login()
      return
    case 'logout':
      await session.logout()
      return
    case 'connectMcp':
      await session.connectMcp(command.name)
      return
    case 'setSearch':
      session.setSearch(command.value)
      return
    case 'applySearch':
      await session.applySearch()
      return
    case 'setModel':
      session.setModel(command.model)
      return
    case 'setEffort':
      session.setEffort(command.effort)
      return
    case 'setServiceTier':
      session.setServiceTier(command.serviceTier)
      return
    case 'setCollaborationMode':
      session.setCollaborationMode(command.name)
      return
    case 'openFolder':
      await pickFolder()
      return
    case 'loadOlderTurns':
      await session.loadOlderTurns()
      return
    case 'resolveApproval':
      session.resolveApproval(command.blockId, command.accept)
      return
    case 'setApprovalDraft':
      session.setApprovalDraft(command.blockId, command.key, command.value)
      return
    case 'setDocumentName':
      await session.setDocumentName(command.name)
      return
    case 'refresh':
      if (session.snapshot.status === 'error') await session.start()
      else await session.refreshCatalog()
      return
    default: {
      const _exhaustive: never = command
      throw new Error(`unhandled command: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

export async function pickFolder(): Promise<void> {
  const { getWindow, getSession } = deps()
  const window = getWindow()
  if (!window) return
  const result = await dialog.showOpenDialog(window, {
    title: 'Open folder',
    properties: ['openDirectory'],
    defaultPath: getSession().snapshot.cwd || undefined,
  })
  if (result.canceled || !result.filePaths[0]) return
  const session = getSession()
  session.setFolderDraft(result.filePaths[0])
  session.applyFolder()
}

export async function pickDirectory(): Promise<string | null> {
  const window = deps().getWindow()
  if (!window) return null
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose project folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}
