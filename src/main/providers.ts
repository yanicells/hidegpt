import { shell } from 'electron'
import type { BrowserWindow } from 'electron'

import { createFakeClaudeSdk } from '../claude/fake'
import { ClaudeSession } from '../claude/session'
import { createDemoTransport } from '../codex/demo'
import { CodexSession } from '../codex/session'
import { spawnCodexAppServer } from '../codex/transport'
import type { Provider, Snapshot } from '../codex/types'
import { startOpenCodeServer } from '../opencode/client'
import { createFakeOpenCodeClient, createFakeServer } from '../opencode/fake'
import { OpenCodeSession } from '../opencode/session'
import { diffSnapshot } from '../shared/snapshot-patch'

export type ActiveSession = CodexSession | OpenCodeSession | ClaudeSession

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
  process.env.HIDEGPT_FAKE === '1' ? () => createDemoTransport() : spawnCodexAppServer,
  (url) => {
    void shell.openExternal(url)
  },
)

let opencodeSession: OpenCodeSession | null = null
let ensureInFlight: Promise<OpenCodeSession> | null = null
let claudeSession: ClaudeSession | null = null
let provider: Provider = 'codex'

export function getCodexSession(): CodexSession {
  return codexSession
}

export function activeSession(): ActiveSession {
  if (provider === 'opencode' && opencodeSession) return opencodeSession
  if (provider === 'claude' && claudeSession) return claudeSession
  return codexSession
}

/** Claude starts on first use; its SDK spawns Claude Code per document, so there is no server to wait for. */
async function ensureClaude(): Promise<ClaudeSession> {
  if (claudeSession) return claudeSession
  const session = new ClaudeSession(process.env.HIDEGPT_FAKE === '1' ? createFakeClaudeSdk() : undefined)
  session.subscribe(sendSnapshot)
  claudeSession = session
  await session.start()
  return session
}

export async function ensureOpencode(): Promise<OpenCodeSession> {
  if (opencodeSession) return opencodeSession
  if (ensureInFlight) return ensureInFlight
  ensureInFlight = (async () => {
    const fake = process.env.HIDEGPT_FAKE === '1'
    const session = new OpenCodeSession(
      fake
        ? () => Promise.resolve(createFakeServer(createFakeOpenCodeClient()))
        : (cwd) => startOpenCodeServer({ cwd }),
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

export async function setProvider(next: Provider, home = false): Promise<void> {
  if (next === provider && (next === 'codex' || (next === 'opencode' ? opencodeSession : claudeSession))) return
  if (next === 'opencode') await ensureOpencode()
  if (next === 'claude') await ensureClaude()
  if (home) (next === 'codex' ? codexSession : next === 'opencode' ? opencodeSession : claudeSession)?.goHome()
  provider = next
  sendSnapshot()
}

export function buildSnapshot(): Snapshot {
  const session = activeSession()
  let snap = session.getSnapshot()
  if (snap.provider !== 'codex') {
    // Identity display follows the ChatGPT account when one is present.
    const codexSnap = codexSession.getSnapshot()
    snap = { ...snap, account: codexSnap.account, requiresAuth: false }
  }
  return snap
}

let pendingSnapshot: ReturnType<typeof setTimeout> | null = null
let deliveredSnapshot: Snapshot | null = null

export function sendSnapshot(): void {
  const snap = buildSnapshot()
  // Batch token bursts, but deliver navigation, new blocks, and completion immediately.
  const previous = deliveredSnapshot
  if (
    snap.streaming &&
    previous?.streaming &&
    snap.provider === previous.provider &&
    snap.route.kind === 'doc' &&
    previous.route.kind === 'doc' &&
    snap.route.threadId === previous.route.threadId &&
    snap.blocks.length === previous.blocks.length &&
    snap.openingThreadId === previous.openingThreadId &&
    snap.error === previous.error
  ) {
    if (!pendingSnapshot)
      pendingSnapshot = setTimeout(() => {
        pendingSnapshot = null
        deliverSnapshot(buildSnapshot())
      }, 32)
    return
  }
  if (pendingSnapshot) clearTimeout(pendingSnapshot)
  pendingSnapshot = null
  deliverSnapshot(snap)
}

/** A freshly loaded window has no snapshot yet, so it gets the whole thing. */
export function sendFullSnapshot(): void {
  deliveredSnapshot = null
  if (pendingSnapshot) clearTimeout(pendingSnapshot)
  pendingSnapshot = null
  deliverSnapshot(buildSnapshot())
}

function deliverSnapshot(snap: Snapshot): void {
  const patch = diffSnapshot(deliveredSnapshot, snap)
  deliveredSnapshot = snap
  const title = snap.route.kind === 'home' ? 'Docs' : snap.title || 'Docs'
  const window = hooks.getWindow()
  window?.setTitle(title)
  window?.webContents.send('snapshot', patch)
  hooks.onChanged(snap)
}

export function closeSessions(): void {
  if (pendingSnapshot) clearTimeout(pendingSnapshot)
  pendingSnapshot = null
  void codexSession.close()
  void opencodeSession?.close()
  void claudeSession?.close()
}
