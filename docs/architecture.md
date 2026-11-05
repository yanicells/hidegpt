# Architecture

HideGPT is an Electron app that looks like Google Docs. Behind it, it talks to one of three local coding agents: Codex (`codex app-server`, JSON-RPC over stdio), OpenCode (`opencode serve`, REST + SSE), or Claude (the Agent SDK, which runs Claude Code). This page covers how the code is organized and the rules behind it.

```
renderer (React)  ──dispatch(Command)──►  main: SessionManager ──► ProviderAdapter (codex | opencode | claude)
      ▲                                        │                         │
      └────── 'snapshot' SnapshotPatch ◄───────┘ ◄──── AdapterEvent ─────┘
                                                                         ▼
                                                     ProcessSupervisor (spawn, timeouts, restart)
```

## 1. Provider-neutral model (`src/shared/`)

The renderer and the session manager only see types from `src/shared/model.ts`:

| Type | What it is |
|---|---|
| `DocSummary` | One document on Home: `id, name, preview, updatedAt, cwd, projectId` |
| `ProjectSummary` | A folder group: `id, name, roots` |
| `ModelOption` | `id, label, efforts[], defaultEffort, serviceTiers[], isDefault` |
| `ModeOption` | Codex collaboration mode or OpenCode agent: `id, label` |
| `AccountSummary` | `label` + `kind` (Codex only; the others sign in outside Docs) |
| `ToolServer` | An MCP server that needs connecting: `name` |
| `Block` | `agent`, `user`, `callout`, or `approval` |
| `ApprovalBlock` | `title, body, fields[], questions[], resolved, pending`, with no raw provider params |
| `Capabilities` | Flags the UI reads instead of `provider === 'codex'` |
| `Snapshot` | Everything the window draws: the active library, the route, and the open document |

Generated Codex types (`src/generated/codex`) and the OpenCode and SDK shapes stay inside their adapter. Each adapter maps its wire types into the shared model. Nothing in `src/shared` or the renderer imports from `src/generated`.

Approvals are the main reason for this split. An adapter keeps the raw request (JSON-RPC id, method, params, OpenCode request id, SDK resolver) in a private map keyed by block id. The renderer gets display data only. Its form drafts stay in local component state, and the answers go back in one `resolveApproval { blockId, accept, answers }` command.

## 2. `ProviderAdapter` (`src/shared/provider.ts`)

There is one interface with three implementations (`src/codex/adapter.ts`, `src/opencode/adapter.ts`, `src/claude/adapter.ts`).

- **Pull methods:**
  - Startup and catalog: `start`, `stop`, `loadCatalog`, `listDocs(search)`, `listSkills(cwd)`.
  - Documents: `openThread`, `loadOlder`, `createThread`, `rename`.
  - Turns: `send`, `interrupt`, `respond(approval reply)`, `releaseThread`.
  - Optional: `createProject`, `login`, `logout`, `connectTool`.
- **Push events** (`onEvent`), a normalized union:
  - Text and blocks: `text` (append a delta to a block), `block` (upsert by id, optionally replacing a local echo), `resolved`.
  - Turns: `turnStarted`, `turnEnded` (always terminal, with an optional error).
  - Thread state: `reset` (replace a thread's blocks after a reconnect), `title`, `closed`.
  - Catalog: `invalidate` (docs, account, projects, skills, or tools changed, so refetch).
  - Connection: `connection` (connecting, ready, or error, plus the stderr tail), `notice`, `loginUrl`.
- **`capabilities`** tells the UI what this provider supports: `login`, `connectTools`, `createProjects`, `serviceTiers`, `modes`, `images`, `olderPages`.

Adapters hold no UI state and know nothing about routes. Every event carries its `threadId`. That is what lets a turn keep streaming while the window shows something else.

## 3. Session manager (`src/main/sessions.ts`)

The session manager is the one place UI state lives. It owns:

- the active provider and its catalog, search, settings (model, effort, tier, mode), and cwd;
- the route (`home`, or `doc` + threadId) and an `opening` token. A newer navigation cancels an older one: there is no promise queue, so nothing can starve;
- `ThreadRuntime` per `provider:threadId`: blocks, streaming flag, older-page cursor, and last-viewed time. Adapter events update the runtime even when that document isn't on screen. Going Home or opening another doc does **not** interrupt or unsubscribe a running turn.
- idle release: a sweep every minute calls `adapter.releaseThread` for runtimes that are off screen, idle, and unseen for 30 minutes (T3's ProviderSessionManager pattern). Before that, reopening a doc is instant: no resume and no refetch.

Rules it enforces:

- **Commands return a result.** `dispatch` resolves to `{ ok: true }` or `{ ok: false, error }`. The composer only clears its draft when the send was accepted.
- **Provider switch** uses a token, so a slow `start()` can't overwrite a newer choice. Each provider shows its own account: Codex's ChatGPT account never appears under OpenCode or Claude.
- **Approvals** belong to their thread runtime. An approval that arrives while you're on Home waits in that document, and the provider waits too. A reply that fails, or that the server rejects, leaves the approval open and shows the error.
- **Errors never replace the whole UI.** A connection failure shows a banner with Refresh. Home and the other libraries keep working.

## 4. Process supervisor (`src/main/supervisor.ts`)

Codex and OpenCode run as child processes. The supervisor gives them:

- **Process groups.** Children are spawned `detached`, and `kill` signals `-pid` (SIGTERM, then SIGKILL after 2 s), so a CLI's own children die with it.
- **An orphan ledger** in `userData/children.json`. On launch, a pid left over from a crash is killed only if its command line still matches what we spawned.
- **An 8 KiB stderr tail**, attached to every spawn, crash, and timeout error, so "exited (1)" comes with the reason.
- **Crash detection and restart** with backoff (0.5 s × 2ⁿ, capped at 10 s, reset after 60 s of uptime). A crash ends every in-flight turn on that provider with a terminal error, so nothing stays stuck on "Working…". After a restart the open doc is reloaded.
- **Request timeouts.** JSON-RPC requests default to 30 s and long ones get 120 s; OpenCode fetches get 15 s; Claude's `initializationResult` gets 25 s. A write to a closed stdin rejects instead of throwing EPIPE.
- **Quit cleanup.** `before-quit` stops every adapter, and a synchronous `exit` hook kills any group still alive.

The Claude SDK spawns its own Claude Code processes. Each `query` is closed when its thread is released or the app quits. The SDK itself is `import()`ed lazily, so it costs nothing until you pick Claude.

## 5. Slim IPC (`src/shared/snapshot-patch.ts`)

Main sends `snapshot` patches on one channel:

```ts
type SnapshotPatch = {
  fields?: Partial<Snapshot>        // changed top-level fields, by reference
  blocks?: { length: number; set?: [index, Block][]; append?: [index, text][] }
}
```

- While streaming, `diffSnapshot` sees that a block only grew (same id and kind, new text starts with the old text) and sends `append: [[i, delta]]` instead of the whole block. IPC becomes proportional to the new tokens, not to the size of the answer.
- Token bursts are coalesced on a 32 ms timer. Navigation, new blocks, and turn end are sent right away.
- The preload no longer keeps its own copy. It forwards patches, and the renderer store applies each one exactly once. On first load, the renderer asks for the full snapshot with `getSnapshot()` (an `invoke`).

## 6. Renderer

- `session-bridge.ts` is a small external store with selector subscriptions (`useSnap(selector)`), so typing in the composer or a streaming block doesn't re-render Home or the toolbar.
- Blocks are memoized by reference. The patch keeps every unchanged block object, so only the streaming block renders.
- Long documents use `content-visibility: auto` on blocks. Opening a doc shows the last page first; "Load earlier" pages back.
- Markdown is split into stable chunks: paragraphs, and inside long code fences too. Only the growing tail re-parses. The markdown libraries load lazily, off the Home path.
- The streaming reveal follows T3's "paragraph" mode: complete lines appear together, so text grows a line at a time like someone typing in Docs, not one token at a time.

## 7. Rules that don't change

- **Stealth.** Window, menus, titles, and copy all read as Google Docs. Provider names appear only where you choose a library.
- **No chat database.** Every document lives in its provider's own store (Codex rollouts, OpenCode's DB, Claude's transcripts). The main process keeps only in-memory runtimes, which it drops on release.
- **Claude credentials.** Docs never reads, stores, or proxies them, and never offers a Claude sign-in.

## 8. Tests

Replay fixtures (`src/test/replay.ts`) script a real protocol transcript: `expect` an outbound message, `emit` an inbound one, `exit` the process. They drive the real adapter and session manager code through:

- lifecycle (initialize → catalog → open → turn → complete);
- request timeouts;
- crash, then restart with backoff;
- a turn that keeps streaming after you go Home, then reopen;
- approvals answered from another route;
- an OpenCode approval reply that fails.

Fixtures come from protocol shapes captured from the installed CLIs (`codex app-server generate-ts`, OpenCode's `/doc` OpenAPI, SDK `sdk.d.ts`). No test sends a prompt to a real model.
