# Architecture

HideGPT is an Electron app that looks like Google Docs. Behind it, it talks to one of three local coding agents:

- **Codex**: `codex app-server`, JSON-RPC over stdio.
- **OpenCode**: `opencode serve`, REST + SSE.
- **Claude**: the Agent SDK, which runs Claude Code.

This page covers how the code is organized and the rules behind it. Much of the design follows [T3 Code](https://github.com/pingdotgg/t3code); see the README's Acknowledgements.

```
renderer (React)  ──dispatch(Command)──►  main: ProviderSessionManager ──► ProviderRegistry ──► ProviderAdapter
      ▲                                         │                                          (codex | opencode | claude)
      └─── 'snapshot' SnapshotPatch ◄── SnapshotPublisher ◄──── AdapterEvent stream ◄────────────┘
                                                                                                  │
                                                                     ProcessSupervisor (spawn, stderr tail, orphans)
```

## 1. Effect in main, React in the renderer

Main and the providers are written in [Effect](https://effect.website) 4, following T3 Code's server. The renderer stays plain React: the Home path ships no Effect runtime.

| Piece | Effect shape |
|---|---|
| `ProcessSupervisor` (`src/provider/ProcessSupervisor.ts`) | A service over Effect's Node spawner. A child lives as long as the `Scope` that spawned it. |
| `ProviderRegistry` (`src/main/ProviderRegistry.ts`) | A service that loads adapters with a dynamic `import()` on first use. `layerAdapters` swaps in fakes for tests and demo mode. |
| `ProviderSessionManager` (`src/main/ProviderSessionManager.ts`) | A service that owns all UI state in a `Ref`. Its pure transitions are in `src/main/session/state.ts`. |
| `SnapshotPublisher` (`src/main/SnapshotPublisher.ts`) | Turns state changes into IPC patches. |
| IPC (`src/main/ipc.ts`) | Each invoke channel has a payload `Schema`, decoded before its handler runs. |

The conventions:

- **Lifetimes are scopes.** A provider session is opened with `Effect.acquireRelease`/`Scope`. Closing it kills the process group, ends the event stream, and settles anything still running. Nothing is torn down by hand in an `if`.
- **Every request has a deadline.** `Effect.timeoutOrElse` turns a hang into a `ProviderTimeoutError`. Requests default to 30 s; OpenCode's prompt gets 60 s, Claude's startup probe 25 s, and a Claude stop 10 s.
- **Retries are `Schedule`s.**
  - A crashed provider restarts with `RESTART_SCHEDULE`: exponential from 0.5 s, capped at 10 s, up to 6 tries, reset after 60 s of uptime.
  - OpenCode's event stream re-subscribes with its own exponential schedule.
- **Background work is a fiber.** Navigation runs in a `FiberHandle`, and refreshes and debounced invalidations run in `FiberMap`s keyed by purpose. Starting a newer one interrupts the older one, so a slow open can never starve a later one.
- **Errors are tagged** (`src/provider/errors.ts`, `Schema.TaggedError`):
  - `ProviderTimeoutError`, `ProcessExitedError` (with the stderr line), `BinaryMissingError`, `NotLoggedInError`, `ProviderRequestError`, `ProviderNotReadyError`, `CommandRejectedError`.
  - Each `message` is already the Docs-style sentence the banner shows.
  - `endsConnection` decides which errors trigger a restart.
- **Contracts are schemas.** `src/shared/contracts.ts` defines `Snapshot`, `Block`, `Command`, `CommandResult`, and `SnapshotPatch` as `effect/Schema`. Main decodes every command at the IPC boundary. The renderer imports only the derived types, through `src/shared/model.ts`.

## 2. Provider-neutral model (`src/shared/`)

The renderer and the session manager only see these types:

| Type | What it is |
|---|---|
| `DocSummary` | One document on Home: `id, name, preview, updatedAt, cwd, projectId` |
| `ProjectSummary` | A folder group: `id, name, roots` |
| `ModelOption` | `id, label, efforts[], defaultEffort, serviceTiers[], isDefault` |
| `ModeOption` | A Codex collaboration mode or an OpenCode agent: `id, label` |
| `AccountSummary` | `kind` + `label`, each from its own provider |
| `ToolServer` | An MCP server, and whether it needs connecting |
| `Block` | `agent` (optionally `commentary`), `user`, `callout`, or `approval` |
| `ApprovalBlock` | `title, body, fields[], questions[], resolved, pending`, with no raw provider params |
| `Capabilities` | Flags the UI reads instead of checking `provider === 'codex'` (`login`, `connectTools`, `createProjects`, `gitProjects`) |
| `Snapshot` | Everything the window draws: the active library, the route, and the open document |

Wire types stay inside their adapter:
- Codex: the vendored client's generated schemas.
- OpenCode: `@opencode-ai/sdk` types.
- Claude: `sdk.d.ts` types.

Each adapter maps its wire types into the shared model in a pure `mapping.ts`. Reasoning is filtered there, never in the UI.

Approvals are the main reason for this split. An adapter keeps the raw request in a private map keyed by block id: a JSON-RPC id, an OpenCode request id, or a Claude `canUseTool` `Deferred`. The renderer gets display data only. Its drafts stay in local component state, and the answers go back in one `resolveApproval { blockId, accept, answers }`.

## 3. `ProviderAdapter` (`src/provider/ProviderAdapter.ts`)

There is one interface with three implementations:

- `src/codex/CodexAdapter.ts`;
- `src/opencode/OpenCodeAdapter.ts`;
- `src/claude/ClaudeAdapter.ts`.

`adapter.openSession` is an `Effect<ProviderSession, ProviderError, Scope>`. It spawns or connects, finishes the handshake within a deadline, and returns:

- **`events`**: a `Stream<AdapterEvent>`.
  - Text and blocks: `text` (append a delta, creating the block if needed), `block` (upsert by id, optionally replacing a local echo), `resolved`.
  - Turns: `turnStarted`, `turnEnded`. `turnEnded` is always terminal and carries an optional error.
  - Thread state: `reset` (replace a thread's blocks after a reconnect), `title`, `closed`.
  - Library: `invalidate` (docs, account, projects, skills, or tools changed, so refetch), `notice`, `loginUrl`.
- **`awaitExit`**: fails when the backend is gone (a process exit or a dead event stream). The manager races it to restart.
- **Pull methods**, each with its own timeout:
  - Library: `loadCatalog`, `listDocs(search)` (a stream, so Home paints the first page early), `listSkills(cwd)`.
  - Documents: `openThread`, `createThread`, `loadOlder`, `rename`.
  - Turns: `send`, `interrupt`, `respond`.
  - Cleanup: `releaseThread`.
  - Optional: `createProject`, `login`, `logout`, `connectTool`.

Adapters hold no UI state and know nothing about routes. Every thread event carries its `threadId`. That is what lets a turn keep streaming while the window shows something else.

### Per provider

- **Codex.** The Effect client in `src/vendor/effect-codex-app-server/` is vendored from T3 Code. It covers JSON-RPC over stdio with no `jsonrpc` field, schema-checked requests and server requests, and termination. Its schemas are generated from the installed CLI with `pnpm protocol`. The adapter echoes the client id the composer used, so a sent message never appears twice.
- **OpenCode.** It uses `@opencode-ai/sdk`'s HTTP client against `opencode serve`.
  - The server gets a random password and listens on 127.0.0.1.
  - The global SSE stream has a 30 s watchdog, since the server heartbeats every 10 s. A stalled or closed stream re-subscribes with backoff, and every open document then reloads (`reset`).
  - A prompt carries a `messageID` in OpenCode's own format, so the echo keeps Docs' id without a re-read.
  - Pending permission and question requests are loaded when a document opens. A subagent's requests route to its root document.
  - A `false` reply from the server keeps the approval open.
- **Claude.** One long-lived `query()` per document that is answering, fed by a prompt queue (T3's streaming-input pattern). It starts on the first send.
  - A turn settles on the `result` frame. If Claude Code exits first, the turn settles as failed, and the next send resumes the transcript.
  - A stop that Claude Code ignores closes the query after 10 s.
  - Models, commands, and login status come from a probe: Claude Code starts with a prompt that never yields and is closed after `initializationResult()`. It has a 25 s deadline, and there is one probe per folder at a time.
  - `canUseTool` becomes an approval block backed by a `Deferred`. `AskUserQuestion` maps onto approval questions.
  - The SDK is `import()`ed lazily.

## 4. Session manager (`src/main/ProviderSessionManager.ts`)

The session manager is the one place UI state lives. It owns:

- the active provider, plus each library's catalog, search, settings (model, effort, tier, mode), cwd, and error;
- the route (`home`, or `doc` + threadId);
- a `ThreadRuntime` per `provider:threadId`: blocks, streaming and stopping flags, older-page cursor, and last-viewed time. Adapter events update the runtime even when that document isn't on screen. Going Home or opening another doc does **not** interrupt or unsubscribe a running turn;
- idle release. A sweep every minute releases runtimes that are off screen, idle, and unseen for 30 minutes, and caps idle runtimes at 12 (T3's ProviderSessionManager pattern). Until then, reopening a doc is instant: no resume and no refetch.

Rules it enforces:

- **Commands return a result.** `dispatch` resolves to `{ ok: true }` or `{ ok: false, error }`. The composer only clears its draft when the send was accepted.
- **Provider switch** is one state write, and each library connects on its own, so a slow connect can't overwrite a newer choice. Each library shows its own account: Codex's ChatGPT account never appears under OpenCode or Claude.
- **Approvals** belong to their thread runtime. An approval that arrives while you're on Home waits in that document, and the provider waits too. A reply that fails, or that the server rejects, leaves the approval open and shows the error.
- **Stopping** shows "Stopping…" until the turn's terminal event. After 10 s it settles anyway, so a lost turn end never traps the document.
- **Errors never replace the whole UI.** A connection failure shows a banner with Refresh. Home and the other libraries keep working.

## 5. Processes (`src/provider/ProcessSupervisor.ts`)

Codex and OpenCode run as child processes. Effect's Node spawner gives each child its own process group. When the session scope closes, it sends SIGTERM to the group, then SIGKILL after 2 s, so a CLI's own children die with it. The supervisor adds:

- `BinaryMissingError` when the CLI is not on PATH;
- an 8 KiB stderr tail on every `ProcessExitedError`, so "exited (1)" comes with the reason;
- **an orphan ledger** (`userData/provider-processes.json`). If main is hard-killed and no finalizers run, the next launch kills a recorded pid, but only if its command line still matches what was spawned.

The Claude SDK spawns its own Claude Code processes. Each `query()` is closed when its document is released, its library closes, or the app quits.

## 6. Slim IPC (`src/main/SnapshotPublisher.ts`, `src/shared/snapshot-patch.ts`)

Main sends `snapshot` patches on one channel:

```ts
type SnapshotPatch = {
  fields: Partial<Snapshot>   // changed top-level fields, by reference
  blocks?: { length: number; set?: [index, Block][]; append?: [index, text][] }
}
```

- While streaming, `diffSnapshot` sees that a block only grew (same id and kind, new text starts with the old text). It then sends `append: [[i, delta]]` instead of the whole block, so IPC is proportional to the new text, not to the size of the answer.
- Token bursts are coalesced into 32 ms frames. Navigation, new blocks, and turn ends go out right away.
- The preload keeps an assembled copy, so `getSnapshot()` is synchronous at startup. The renderer store applies the same patches.

## 7. Renderer (`src/renderer/`)

- `session-bridge.ts` is the store over the preload. `dispatch` returns the command's `CommandResult` and never throws.
- `components/home/` and `components/document/` render the snapshot. The UI branches on `capabilities`, never on provider names.

## 8. Rules that don't change

- **Stealth.** Window, menus, titles, and copy all read as Google Docs. Provider names appear only where you choose a library.
- **No chat database.** Every document lives in its provider's own store: Codex rollouts, OpenCode's DB, Claude's transcripts. Main keeps only in-memory runtimes, which it drops on release.
- **Claude credentials.** Docs never reads, stores, or proxies them, and never offers a Claude sign-in. People sign in with `claude` in a terminal.

## 9. Tests

Tests use `@effect/vitest`, and `TestClock` drives deadlines and backoff. Each provider has a fake that replaces **only the process boundary**, so the real adapter, client, and schemas run:

| Fake | Replaces |
|---|---|
| `src/codex/FakeCodex.ts` | `codex app-server`, speaking real JSON-RPC lines over in-memory stdio |
| `src/opencode/FakeOpenCode.ts` | `opencode serve`, as an injected `fetch` that serves the REST routes and the SSE stream to the real SDK client |
| `src/claude/FakeClaude.ts` | the SDK's `query()` and session functions, answering with the frames Claude Code writes |

The suites cover the lifecycle, request timeouts, a crash and its restart, a dead or stalled event stream, a turn that keeps streaming after you go Home, approvals answered from another route, a failed approval reply, stop handling, and paging.

The same fakes back demo mode (`HIDEGPT_FAKE=1`), which serves the fictional library in `src/provider/demoLibrary.ts`. Screenshots and the bench use it too.

Fixture shapes come from the installed CLIs (`codex app-server generate-ts`, OpenCode's `/doc` OpenAPI, the SDK's `sdk.d.ts`). No test sends a prompt to a real model.

## 10. Adding a provider

1. Add its id to `ProviderId` and `CAPABILITIES` (`src/shared/`), and its label in `src/shared/labels.ts`.
2. Write `src/<provider>/mapping.ts`: pure functions from its wire types to `DocSummary`, `Block`, `ModelOption`, and so on.
3. Write `src/<provider>/<Name>Adapter.ts`, exporting `make(...)`: `ProviderAdapter`.
   - Spawn through `ProcessSupervisor`, or connect inside the session `Scope`.
   - Put a deadline on every call.
   - Map failures to the tagged errors.
   - Make `awaitExit` fail when the backend dies.
   - Settle every running turn with `turnEnded` when anything ends.
4. Register it in `ProviderRegistry.layer` (dynamic import) and in `src/main/demo.ts` with a fake.
5. Write a fake at the process boundary and focused adapter tests in the style above. Check T3 Code first: it may already have an adapter for that provider.
