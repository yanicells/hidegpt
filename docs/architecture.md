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

| Piece                                                           | Effect shape                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ProcessSupervisor` (`src/provider/ProcessSupervisor.ts`)       | A service over Effect's Node spawner. A child lives as long as the `Scope` that spawned it.                                   |
| `ProcessLedger` (`src/provider/ProcessLedger.ts`)               | A service over Effect's `FileSystem`: the orphan ledger, schema-decoded and written atomically.                               |
| `ProviderRegistry` (`src/main/ProviderRegistry.ts`)             | A service that loads adapters with a dynamic `import()` on first use. `layerAdapters` swaps in fakes for tests and demo mode. |
| `ProviderSessionManager` (`src/main/ProviderSessionManager.ts`) | A service that owns all UI state in a `Ref`. Its pure transitions are in `src/main/session/state.ts`.                         |
| `SnapshotPublisher` (`src/main/SnapshotPublisher.ts`)           | Turns state changes into IPC patches.                                                                                         |
| IPC (`src/main/ipc.ts`)                                         | Registers each channel from its row in the `Ipc*` tables in `contracts.ts`; a payload is decoded before its handler runs.     |

The conventions:

- **Lifetimes are scopes.** A provider session is opened with `Effect.acquireRelease`/`Scope`. Closing it kills the process group, ends the event stream, and settles anything still running. Nothing is torn down by hand in an `if`.
- **Every request has a deadline.** `Effect.timeoutOrElse` turns a hang into a `ProviderTimeoutError`. Requests default to 30 s; OpenCode's prompt gets 60 s, Claude's startup probe 25 s, and a Claude stop 10 s.
- **Retries are `Schedule`s.**
  - A crashed provider restarts with `RESTART_SCHEDULE`: exponential from 0.5 s, capped at 10 s, up to 6 tries, reset after 60 s of uptime.
  - OpenCode's event stream re-subscribes with its own exponential schedule.
- **Background work is a fiber.** Navigation runs in a `FiberHandle`, and refreshes and debounced invalidations run in `FiberMap`s keyed by purpose. Starting a newer one interrupts the older one, so a slow open can never starve a later one.
- **Errors are tagged** (`src/provider/errors.ts`, `Schema.TaggedError`):
  - `ProviderTimeoutError`, `ProcessExitedError` (with the stderr line), `BinaryMissingError`, `NotLoggedInError`, `ProviderRequestError`, `ProviderNotReadyError`, `ProviderDefectError`, `CommandRejectedError`.
  - Each `message` is already the Docs-style sentence the banner shows.
  - `endsConnection` decides which errors trigger a restart.
  - Anything else is a defect. Its raw text never reaches the page: `describeFailure` and `reportDefect` (`src/provider/DefectReport.ts`, used by main and the adapters) log the defect parts of the cause under a report id, and the banner says "Something went wrong. Docs saved a report." Work nobody awaits (refreshes nobody joins, adapter forks, OpenCode's URL reader) is wrapped in `logDefects`, so its defects are logged instead of lost. The idle sweep logs a failed run and keeps going. The snapshot publisher reports a defect, forgets what the window has, and starts over a second later (up to five times), so the next patch is the whole snapshot. A restart keeps counting `seq` (a patch lost to the defect still used its number), so that whole patch is newer than anything the window has and still applies. Handlers that a vendored client or an SDK calls (Codex notifications and server requests, Claude's `canUseTool`) catch their own dies: Codex reports one and restarts the session, Claude reports it and refuses the tool.
- **Logs are NDJSON files in `userData/logs`** (`src/main/logging/`, adapted from T3 Code's rotating sink and provider event logger). Help → Report a problem… opens the folder.
  - Logs never hold text a person or a provider wrote. A provider's error can quote what was sent, and a process can print anything to stderr, so a tagged error is logged by `errorLogFields` (its tag, provider, operation, exit code…), never by its sentence. A stopped process logs only whether it printed to stderr and how many characters (`hasStderr`, `stderrLength`).
  - `main.ndjson`: every `Effect.log*` in main as one JSON line (10 MB, five rotated files), annotated with `provider` and `command` where they apply. Debug lines keep the connection timeline. Because Debug is kept, the Codex client's frame logging must stay off (`CLIENT_OPTIONS` in `CodexAdapter.ts`, guarded by a test): frames hold prompts and answers.
  - `activity/personal.ndjson`, `work.ndjson`, `school.ndjson` (named for the library, never the provider; 5 MB, three rotated files): each canonical event the library reported, encoded with the `src/provider/events.ts` schemas, with every text value written as its length. Ids, kinds, statuses and failure classes stay; prompts, answers, commands and their output, request wording, titles, errors, notices and sign-in links never do. The key allowlist in `ProviderEventLog.ts` is deny-by-default: a new text field is redacted until someone lists its key. Only an item's first delta is written. `pnpm replay:events <file>` folds a log through `applyThreadEvent` (`src/main/session/replay.ts`) and prints each document's turns and items, so a turn that never ended shows up as still open. What main does without an event (the optimistic echo, Stopping, the stop deadline, an answered question, the items a document opened with) is not in the log.
  - If `logs/` is deleted while Docs runs, the next write makes it again.
- **Startup stays cheap.** `src/main/index.ts` names the app, turns on Node's compile cache (`userData/compile-cache`), then imports `app.ts`, as T3 Code's desktop `boot.ts` does. Main bundles its dependencies (Effect, the OpenCode SDK) like T3's desktop build; only `electron` and the Claude SDK, which starts the CLI inside its package, stay external. Each adapter is its own chunk, loaded when its library first connects.
- **Contracts are schemas.** `src/shared/contracts.ts` defines `Snapshot`, `Block`, `Command`, `CommandResult`, and `SnapshotPatch` as `effect/Schema`, plus the IPC tables: `IpcInvoke` (each renderer request's payload, result, and the answer when the payload does not decode), `IpcEvents` (main's pushes) and `IpcSnapshotNow`. Main decodes every payload at the IPC boundary. `HideGptApi` (`src/shared/api.ts`) is derived from the tables, and the plain channel names live in `src/shared/channels.ts` so the preload loads no Effect. The renderer imports only the derived types, through `src/shared/model.ts`.

## 2. Provider-neutral model (`src/shared/`)

The renderer and the session manager only see these types:

| Type             | What it is                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DocSummary`     | One document on Home: `id, name, preview, updatedAt, cwd, projectId`                                                     |
| `ProjectSummary` | A folder group: `id, name, roots`                                                                                        |
| `ModelOption`    | `id, label, efforts[], defaultEffort, serviceTiers[], isDefault`                                                         |
| `ModeOption`     | A Codex collaboration mode or an OpenCode agent: `id, label`                                                             |
| `AccountSummary` | `kind` + `label`, each from its own provider                                                                             |
| `ToolServer`     | An MCP server, and whether it needs connecting                                                                           |
| `Block`          | `agent` (optionally `commentary`), `user`, `callout`, or `approval`                                                      |
| `ApprovalBlock`  | `title, body, fields[], questions[], resolved, pending`, with no raw provider params                                     |
| `Capabilities`   | Flags the UI reads instead of checking `provider === 'codex'` (`login`, `connectTools`, `createProjects`, `gitProjects`) |
| `Snapshot`       | Everything the window draws: the active library, the route, and the open document                                        |

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

- **`events`**: a `Stream<AdapterEvent>` of the canonical events in `src/provider/events.ts` (adapted from T3 Code's orchestration-v2 contract).
  - Turns: `turn.started` and `turn.ended`. Each carries the app's `TurnId`, which the manager allocates before `send`. `turn.ended` is the turn's one terminal and has a `status` (`completed`, `interrupted`, `failed`) and, when failed, a typed `Failure` (`usage_limit`, `auth`, `provider_error`, `transport_error`, `validation_error`, `unknown`). The failure's provider text (`detail`, redacted by `src/provider/failure.ts`) goes to the log only.
  - Items: `item.upserted` (insert or replace by id, optionally replacing a local echo) and `item.delta` (append streamed text). Items are typed data (`user`, `assistant`, `tool`, `request`, `notice`), never sentences.
  - Thread state: `thread.reset` (replace a thread's items after a reconnect, with the turn still running, if any), `thread.renamed`, `thread.closed`.
  - Library: `invalidate` (docs, account, projects, skills, or tools changed, so refetch), `notice`, `loginUrl`.
- **Turn bookkeeping** is shared: `src/provider/turnTracker.ts` (adapted from T3's `pendingRootTurns`) knows each thread's open turn, its native id, and whether Stop was pressed, and emits the turn events itself, so a duplicate provider terminal is dropped and a stopped turn always ends as `interrupted`.
- **Legacy adapters.** The three adapters still emit the older block events (`src/provider/legacyEvents.ts`); `fromLegacy` wraps each one with a tracker, and `ProviderRegistry` and `demo.ts` apply it. Each adapter moves onto canonical items in ARCH-4.
- **`awaitExit`**: fails when the backend is gone (a process exit or a dead event stream). The manager races it to restart.
- **Pull methods**, each with its own timeout:
  - Library: `loadCatalog`, `listDocs(search)` (a stream, so Home paints the first page early), `listSkills(cwd)`.
  - Documents: `openThread`, `createThread`, `loadOlder`, `rename`.
  - Turns: `send(threadId, turnId, …)`, `interrupt(threadId, turnId)`, `respond`.
  - Cleanup: `releaseThread`.
  - Optional: `createProject`, `login`, `logout`, `connectTool`. Each is present exactly when its `Capabilities` flag is on (`CAPABILITY_METHODS` in `ProviderAdapter.ts`); `src/provider/capabilities.test.ts` checks all three adapters.

Adapters hold no UI state and know nothing about routes. Every thread event carries its `threadId`. That is what lets a turn keep streaming while the window shows something else.

### Per provider

- **Codex.** The Effect client in `src/vendor/effect-codex-app-server/` is vendored from T3 Code. It covers JSON-RPC over stdio with no `jsonrpc` field, schema-checked requests and server requests, and termination. Its schemas are generated from the installed CLI with `pnpm protocol`, and `pnpm protocol --check` fails when they drift (it only dumps schemas; it starts no thread or turn). The vendored package's own tests run with `pnpm test`. The adapter echoes the client id the composer used, so a sent message never appears twice.
- **OpenCode.** It uses `@opencode-ai/sdk`'s HTTP client against `opencode serve`.
  - The server gets a random password and listens on 127.0.0.1.
  - The global SSE stream has a 30 s watchdog, since the server heartbeats every 10 s. A stalled or closed stream re-subscribes with backoff, and every open document then reloads (`reset`).
  - A prompt carries a `messageID` in OpenCode's own format, so the echo keeps Docs' id without a re-read.
  - Pending permission and question requests are loaded when a document opens. A subagent's requests route to its root document.
  - A `false` reply from the server keeps the approval open.
- **Claude.** One long-lived `query()` per document that is answering, fed by a prompt queue (T3's streaming-input pattern). It starts on the first send.
  - A turn settles on the `result` frame. If Claude Code exits first, the turn settles as failed, and the next send resumes the transcript (checked with `getSessionInfo` when no answer had arrived yet).
  - A stop that doesn't end the turn within 10 s (no answer, or no `result` frame) closes the query, so the next send works.
  - Models, commands, and login status come from a probe: Claude Code starts with a prompt that never yields and is closed after `initializationResult()`. It has a 25 s deadline, and there is one probe per folder at a time.
  - `canUseTool` becomes an approval block backed by a `Deferred`. `AskUserQuestion` maps onto approval questions.
  - The SDK is `import()`ed lazily.

## 4. Session manager (`src/main/ProviderSessionManager.ts`)

The session manager is the one place UI state lives. It owns:

- the active provider, plus each library's catalog, search, settings (model, effort, tier, mode), cwd, and error;
- the route (`home`, or `doc` + threadId);
- a `ThreadRuntime` per `provider:threadId`: typed items, the open turn (its id and phase: `starting`, `running` or `stopping`), older-page cursor, and last-viewed time. `src/main/session/present.ts` is the one place items become `Block`s and Docs wording, cached per item so an unchanged item keeps its block; `src/shared/stealth.ts` is the banned-word gate its tests run every string through. Adapter events update the runtime even when that document isn't on screen. Going Home or opening another doc does **not** interrupt or unsubscribe a running turn;
- idle release. A sweep every minute releases runtimes that are off screen, idle, and unseen for 30 minutes, and caps idle runtimes at 12 (T3's ProviderSessionManager pattern). Until then, reopening a doc is instant: no resume and no refetch. The document each library shows counts as on screen, even while another library is active, so switching back never lands on a blank page.

Rules it enforces:

- **Commands return a result.** `dispatch` resolves to `{ ok: true }` or `{ ok: false, error }`. The composer only clears its draft when the send was accepted.
- **Provider switch** is one state write, and each library connects on its own, so a slow connect can't overwrite a newer choice. Each library shows its own account: Codex's ChatGPT account never appears under OpenCode or Claude.
- **Approvals** belong to their thread runtime. An approval that arrives while you're on Home waits in that document, and the provider waits too. A reply that fails, or that the server rejects, leaves the approval open and shows the error.
- **Turns are named.** A turn event for any turn but the open one is ignored, so a late terminal from an older turn can't end a newer one.
- **Stopping** shows "Stopping…" until the turn's terminal event. After 10 s it settles anyway, so a lost turn end never traps the document; the timer names its turn, so it never ends a newer one. Stop pressed before the provider confirmed the turn waits for that confirmation (up to 10 s) instead of being lost.
- **A failed turn** shows Docs' sentence for its failure class on the banner; the provider's own text goes to the main log.
- **Errors never replace the whole UI.** A connection failure shows a banner with Refresh. Home and the other libraries keep working.
- **Defects don't freeze a connection** (T3's `catchCause` pattern). A defect while applying events ends the session like a crash, so it restarts; one anywhere else in supervision, or a provider chunk that fails to load, leaves that library in error with the message (and the shown document stale) until the next command or library switch connects it again.

## 5. Processes (`src/provider/ProcessSupervisor.ts`)

Codex, OpenCode and Claude Code run as child processes. Effect's Node spawner gives each child its own process group. When the session scope closes, it sends SIGTERM to the group, then SIGKILL after 2 s, so a CLI's own children die with it. The supervisor adds:

- `BinaryMissingError` when the CLI is not on PATH, and a `ProviderRequestError` saying what failed for any other spawn error;
- an 8 KiB stderr tail on every `ProcessExitedError`, so "exited (1)" comes with the reason;
- **an orphan ledger** (`ProcessLedger`, `userData/provider-processes.json`). If main is hard-killed and no finalizers run, the next launch reaps what it left. A pid alone proves nothing after a crash, so a process is killed only while it is still the one recorded: the same pid and the same start time (epoch ms, read from `ps` in UTC). Each entry keeps the spawned leader (pid, start time, and the command as spawned: a full path for Claude Code, so another app's Claude Code never matches), its process tree (MCP servers and tools, re-read every 5 s while it runs, as T3 Code's `trackDescendants` does, with a light `ps` that leaves out command lines; `ps` and `sysctl` time out after 5 s), and its owner (main's pid and start time). Reaping keeps entries whose owner still runs (another instance; insurance only, since the single-instance lock below already keeps a second Docs off the same ledger), drops entries from before the last boot, kills the leader's group when the leader still matches, and kills each recorded tree member that still matches. A group whose leader is gone is never killed as a group, because its pid may now belong to an unrelated program; after a crash, members that started after the last re-read leak. When a process ends normally, `stop` re-reads its tree, kills the members that still match (a daemon that left the group with `setsid` survives the group kill otherwise), and forgets it, as T3 Code's `tracker.stop` does, so a normal exit and a crash kill the same processes. Writes go through a temp file and a rename, keep other owners' entries, and a file that does not decode counts as empty. If `ps` fails, the file is left as it is.

The Claude SDK starts Claude Code itself, so the adapter hands it `spawnClaudeCodeProcess` from `callbackSpawner`, after T3 Code's `spawnClaudeProcessGroup`. Each process leads its own group, sits in the ledger while it runs, has its stderr drained (the last line explains a failed start), and its group is killed when it exits or when the library's scope closes; then the ledger's `stop` kills what left the group. A closing scope reads the trees first and waits for every `stop`, so a quit leaves no record. Servers from `spawn` are stopped the same way when their scope closes. The SDK's env is passed through untouched; Docs never reads it. Each `query()` is also closed when its document is released.

Only one Docs runs per profile (`app.requestSingleInstanceLock`, as in T3 Code's `DesktopClerk`). The lock is taken at the top of `app.ts`, before the runtime runs, so a second launch builds nothing and quits. The first one focuses its window; a launch that arrives during startup is remembered and focuses the window once it exists. Demo mode keeps no ledger and skips the lock, so `pnpm screenshot` runs beside the real app.

Quitting follows T3 Code's desktop lifecycle. The first `before-quit` is cancelled, every scope closes (so the processes above get their SIGTERM), and then the app quits for real. Activation opens no window while that shutdown runs. A shutdown that takes longer than 5 s exits anyway, and the ledger cleans up on the next launch.

## 6. Slim IPC (`src/main/SnapshotPublisher.ts`, `src/shared/snapshot-patch.ts`)

Main sends `snapshot` patches on one channel:

```ts
type SnapshotPatch = {
  fields: Partial<Omit<Snapshot, 'blocks'>> // changed top-level fields, by reference
  blocks?: { length: number; set?: [index, Block][]; append?: [index, text][] }
  seq: number // counts up by one per patch
}
```

- While streaming, `diffSnapshot` sees that a block only grew (same id and kind, new text starts with the old text). It then sends `append: [[i, delta]]` instead of the whole block, so IPC is proportional to the new text, not to the size of the answer.
- Token bursts are coalesced into 32 ms frames. Navigation, new blocks, and turn ends go out right away.
- The first patch, and the one main sends once the page loads, carries every field plus all blocks as `set`.
- A read of the whole snapshot (`snapshot-now`, `getSnapshot()`) returns it with the `seq` of the last patch it includes, and `applyPatchOnce` skips any patch at or below that. A patch main sent before answering a read, but that arrives after it, is never applied twice: not at startup, and not when StrictMode or HMR reconnects the renderer store.
- The preload only relays. It starts from what main last published (one `sendSync` before the first paint) and applies the patches that land before the page reads it, so `getSnapshot()` is the real library at startup. That first read hands the snapshot over: the preload drops its copy and stops listening, and the renderer store subscribes in the same task.

## 7. Renderer (`src/renderer/`)

- `session-bridge.ts` is the store over the preload. `dispatch` returns the command's `CommandResult` and never throws. A failure shows on the banner until it is dismissed or a later command succeeds; `request` is the same without the banner, for callers that show the error themselves.
- Errors never replace the page. Library and command errors sit on a dismissible banner with Refresh.
- Render errors stay small (`components/layout/RenderErrorBoundary.tsx`, from T3). A block that throws shows "This part of the document couldn't be displayed." in its row, and its next version tries again. A throw anywhere else shows a plain "Something went wrong" page with Reload.
- `components/home/` and `components/document/` render the snapshot. The UI branches on `capabilities`, never on provider names.

### Streaming stays cheap at any length

A streamed delta should cost the same at 300 turns as at 3. Each rule below removes work that grew with the document:

- **Selectors, not one copy.** `useShellSnapshot()` (App, chrome, Home) skips patches that touch only the blocks; `useBlocks()` (Document) takes the blocks. One IPC listener applies each patch once. Patches keep unchanged blocks' identity, so `BlockRow`, `Tabs` and `Composer` are memoized on identity. Handlers that need the latest snapshot read it from a ref that a layout effect keeps current (`onNew` in `app.tsx`), so they stay stable across patches. This follows T3 Code's thread-detail atoms.
- **No extra layout per delta.** `useFollowBottom` scrolls from a ResizeObserver on the content (not the paper, whose minimum height hides a short document's growth) and on the scroller (a shorter window), after the browser's own layout. An IntersectionObserver on the page end says whether you are near the bottom. A document opens at the top and follows once you scroll to its end or ask. Moving up lets go at once, before that frame's resize could pull the page back, as in T3 Code's timeline viewport: wheel, up keys and a press on the scrollbar as they happen, and any other upward scroll (dragging a selection, focus moving to a link above) from the scroll event. The browser sends scroll events just before the frame's own layout, so the position read there forces none extra (this holds while nothing changes the page in an animation-frame callback). A shrinking scroll range (a shorter document, a taller window) is not taken for scrolling up. Following resumes once you leave the end and come back. A tab jump and "Load earlier" let go on purpose. "Load earlier" keeps your place with `useKeepPlace`: the first row when loading starts is the anchor, and the page scrolls by however far the new rows push its bottom edge, with the browser's scroll anchoring off meanwhile. The button waits until the document has finished opening. Main ends loading in the snapshot that adds the rows, so one restore sees them. A tab jump settles on its target when its smooth scroll ends, unless you take over first.
- **Off-screen blocks skip rendering.** `.doc-block` has `content-visibility: auto`; `contain-intrinsic-size: auto` keeps each block's real height once seen. Containment keeps a block's edge margins inside it instead of collapsing them with its neighbours'. The Docs page gives blocks no margin of their own and an answer's outer margins are zero, so the spacing matches the uncontained page; the only difference is a callout or suggestion directly before a question, where the two margins add instead of collapsing. The streamed block is exempt, since it is always on screen, and so is a block holding a suggestion, whose card hangs into the margin where paint containment would clip it.
- **Pagination is the one layout read.** The print layout (`pages.ts`) re-measures the page once per frame while text changes, then writes every break. Measuring a unit inside a skipped block lays that block out, so on a long document this costs more than the rest of the streaming path. It is bounded to one pass per frame, not one per delta; making it skip off-screen blocks is open work.
- **Opening never blocks.** `useProgressiveRows` renders the first 12 rows at once, then 12 per task, and the composer appears with the last rows. Snapshot updates render synchronously, and a transition would starve while an answer streams, so these are plain steps. `Document` mounts once per thread, so each opens fresh.
- **Markdown parses once.** `markdownRenderer.ts` (from T3) freezes one unified processor and keeps an LRU of rendered elements of about 500k characters. `splitMarkdownBlocks` (from T3) cuts an answer at closed blocks, so streaming re-parses only the last one, and reopening a document parses nothing. Syntax that ties blocks together (definitions, footnotes, raw HTML) keeps an answer whole, but only outside code fences.
- **Markdown loads after Home.** The Markdown stack is its own chunk (`loadMarkdown.ts`), fetched once the page is idle. An answer shows as plain text for the frame before it arrives.
- **No client-side reveal.** Main already batches text into 32 ms frames (§6), and T3 Code doesn't reveal text on the client either.

### The window (`src/main/window.ts`)

- A crashed or killed renderer reloads, at most 3 times a minute per window (T3's `DesktopWindow`); the reload's `did-finish-load` resyncs the snapshot. A renderer unresponsive for 15 s is killed, so it reloads the same way.
- Every permission is denied except clipboard writes (copying a document link).
- `docs://app` sends the CSP as a header as well as `index.html`'s meta tag. `docs://local` serves only images under `userData/images` (pasted) and images in the open document's questions; anything else gets 403.

## 8. Rules that don't change

- **Stealth.** Window, menus, titles, and copy all read as Google Docs. Provider names appear only where you choose a library.
- **No chat database.** Every document lives in its provider's own store: Codex rollouts, OpenCode's DB, Claude's transcripts. Main keeps only in-memory runtimes, which it drops on release.
- **Claude credentials.** Docs never reads, stores, or proxies them, and never offers a Claude sign-in. People sign in with `claude` in a terminal.

## 9. Tests

Tests use `@effect/vitest`, and `TestClock` drives deadlines and backoff. Each provider has a fake that replaces **only the process boundary**, so the real adapter, client, and schemas run:

| Fake                           | Replaces                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `src/codex/FakeCodex.ts`       | `codex app-server`, speaking real JSON-RPC lines over in-memory stdio                                          |
| `src/opencode/FakeOpenCode.ts` | `opencode serve`, as an injected `fetch` that serves the REST routes and the SSE stream to the real SDK client |
| `src/claude/FakeClaude.ts`     | the SDK's `query()` and session functions, answering with the frames Claude Code writes                        |

The suites cover the lifecycle, request timeouts, a crash and its restart, a dead or stalled event stream, a turn that keeps streaming after you go Home, approvals answered from another route, a failed approval reply, stop handling, and paging.

The same fakes back demo mode (`HIDEGPT_FAKE=1`), which serves the fictional library in `src/provider/demoLibrary.ts`. Screenshots and the bench use it too.

Fixture shapes come from the installed CLIs (`codex app-server generate-ts`, OpenCode's `/doc` OpenAPI, the SDK's `sdk.d.ts`). No test sends a prompt to a real model.

**Replay fixtures** add recordings from the real CLIs. `pnpm record:codex` and `pnpm record:claude` drive the real Codex and Claude adapters against the installed CLIs and write what passed between them to `src/<provider>/fixtures/*.ndjson`, scrubbed. The `*.replay.test.ts` suites then play those recordings back to the adapters: the vendored `replay.ts` for Codex, and `src/claude/replay.ts` for the Agent SDK. A replay pins what the adapter sends and how it handles real answers. It only reflects a newer CLI after someone re-records. The committed `library` recordings need no prompt and no login. The `turn` recordings send real prompts, so only the owner records them, with `HIDEGPT_RECORD_TURNS=1`. Until then their tests are skipped. See [replay-fixtures.md](replay-fixtures.md).

## 10. Adding a provider

1. Add its id to `ProviderId` and `CAPABILITIES` (`src/shared/`), and its label in `src/shared/labels.ts`.
2. Write `src/<provider>/mapping.ts`: pure functions from its wire types to `DocSummary`, typed items (`src/provider/events.ts`), `ModelOption`, and so on. Leave the wording to `present.ts`.
3. Write `src/<provider>/<Name>Adapter.ts`, exporting `make(...)`: `ProviderAdapter`.
   - Spawn through `ProcessSupervisor`, or connect inside the session `Scope`.
   - Put a deadline on every call.
   - Map failures to the tagged errors.
   - Make `awaitExit` fail when the backend dies.
   - Use a `TurnTracker` for turns, so each ends exactly once, including when anything else ends.
4. Register it in `ProviderRegistry.layerAfter` (dynamic import) and in `src/main/demo.ts` with a fake.
5. Write a fake at the process boundary and focused adapter tests in the style above. Check T3 Code first: it may already have an adapter for that provider.
