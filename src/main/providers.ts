import { shell } from 'electron'
import type { BrowserWindow } from 'electron'

import { createFakeTransport } from '../codex/fake'
import { CodexSession } from '../codex/session'
import { spawnCodexAppServer } from '../codex/transport'
import type { Provider, Snapshot } from '../codex/types'
import { startOpenCodeServer } from '../opencode/client'
import { createFakeOpenCodeClient, createFakeServer } from '../opencode/fake'
import { OpenCodeSession } from '../opencode/session'

export type ActiveSession = CodexSession | OpenCodeSession

type ProvidersHooks = {
  getWindow: () => BrowserWindow | null
  onChanged: (snap: Snapshot) => void
}

let hooks: ProvidersHooks = {
  getWindow: () => null,
  onChanged: () => {},
}

/** Wire window/menu collaborators without importing those modules (avoids cycles). */
export function initProviders(next: ProvidersHooks): void {
  hooks = next
}

const codexSession = new CodexSession(
  process.env.HIDEGPT_FAKE === '1' ? () => createFakeTransport() : spawnCodexAppServer,
  (url) => {
    void shell.openExternal(url)
  },
)

let opencodeSession: OpenCodeSession | null = null
let ensureInFlight: Promise<OpenCodeSession> | null = null
let provider: Provider = 'codex'

export function getCodexSession(): CodexSession {
  return codexSession
}

export function activeSession(): ActiveSession {
  return provider === 'opencode' && opencodeSession ? opencodeSession : codexSession
}

export async function ensureOpencode(): Promise<OpenCodeSession> {
  if (opencodeSession) return opencodeSession
  if (ensureInFlight) return ensureInFlight
  ensureInFlight = (async () => {
    const fake = process.env.HIDEGPT_FAKE === '1'
    const session = new OpenCodeSession(
      fake ? () => Promise.resolve(createFakeServer(createFakeOpenCodeClient())) : (cwd) => startOpenCodeServer({ cwd }),
    )
    session.subscribe(sendSnapshot)
    // OpenCodeSession.start() never throws — failures land on snapshot status/error.
    await session.start()
    opencodeSession = session
    return session
  })()
  try {
    return await ensureInFlight
  } finally {
    ensureInFlight = null
  }
}

export async function setProvider(next: Provider): Promise<void> {
  if (next === provider && (next === 'codex' || opencodeSession)) return
  if (next === 'opencode') {
    await ensureOpencode()
  }
  provider = next
  sendSnapshot()
}

export function buildSnapshot(): Snapshot {
  const session = activeSession()
  let snap = session.getSnapshot()
  if (snap.provider === 'opencode') {
    // Identity display follows the ChatGPT account when one is present.
    const codexSnap = codexSession.getSnapshot()
    snap = { ...snap, account: codexSnap.account, requiresAuth: false }
  }
  return snap
}

export function sendSnapshot(): void {
  const snap = buildSnapshot()
  const title = snap.route.kind === 'home' ? 'Docs' : snap.title || 'Docs'
  const window = hooks.getWindow()
  window?.setTitle(title)
  window?.webContents.send('snapshot', snap)
  hooks.onChanged(snap)
}

export function closeSessions(): void {
  void codexSession.close()
  void opencodeSession?.close()
}
