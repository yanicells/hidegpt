# AGENTS.md — HideGPT

HideGPT is a personal macOS stealth client for the user's own AI subscriptions.
It looks like Google Docs (light, student-y) but behaves like a chatbot.
There is no custom agent, no custom model plumbing, no chat database —
every capability comes from a provider subprocess that shares the user's
existing logins, and the UI is a Docs costume over it.

## What it is

- **Electron app** (`src/main/app.ts`, `src/preload/index.ts`, `src/renderer/`).
  React 19 renderer, IPC snapshot model: the main process owns session state
  and pushes `Snapshot` patches to the window; the renderer dispatches
  `Command`s back and gets a `CommandResult` (`src/shared/api.ts`). Window
  title = document title, app name is "Docs". The full design is in
  `docs/architecture.md`; read it before changing main, preload or providers.
- **Home = Docs file list.** `components/home/` renders a template
  strip ("Start a new document") plus recent documents and browsable project folders.
  A document = one provider thread/session. Search filters server-side.
- **Document = one thread.** `components/document/` renders provider
  blocks as page content on a paper-on-gray canvas (`styles/`, Arial
  11pt, `--paper-width: 816px`). The composer is the last paragraph
  (`textarea.composer`, Enter to send). User turns render as bold body
  sections with separators, agent turns as Markdown body
  (`components/ui/Markdown.tsx`: T3's cached unified renderer with
  remark-gfm, loaded after Home paints). A tabs
  rail mirrors Docs' "Document tabs" and jumps between questions.
- **Stealth rule:** nothing on screen may read as AI. Model/effort/service-tier/mode live
  in toolbar chips styled like Docs controls, never as raw model ids.
  Usage meters, provider names, and connection banners do not belong in the
  page — surface them under Tools, if at all. Toolbar dropdowns are portaled
  popovers (never inline in the scroll row); the model list is searchable.
  Plan mode is not offered on either provider.

## Providers (all three are just transports)

Each provider is one `ProviderAdapter` (`src/provider/ProviderAdapter.ts`)
that maps its own wire types into the shared model in a pure `mapping.ts`.

- **Codex** (`src/codex/CodexAdapter.ts`): spawns `codex app-server` through
  the vendored Effect client (`src/vendor/effect-codex-app-server/`, from
  T3 Code): JSON-RPC over stdio with **no `jsonrpc` field on the wire**.
  Handshake is `initialize` with `clientInfo.name: hidegpt` +
  `capabilities.experimentalApi: true`, then `initialized`. Shares `~/.codex`
  with the Codex CLI and ChatGPT desktop app — threads, projects, models,
  MCP servers (Notion etc.) come from there. Cloud ChatGPT Chat / Cloud Work
  are out of scope (no documented API). The protocol schemas under
  `src/vendor/effect-codex-app-server/_generated/` come from `pnpm protocol`
  (the installed CLI's `codex app-server generate-ts`) — never hand-edit them,
  never invent protocol methods.
- **OpenCode** (`src/opencode/OpenCodeAdapter.ts`): spawns `opencode serve` on
  127.0.0.1 with a random server password and talks to it with the official
  `@opencode-ai/sdk` client (REST + the global SSE stream). It uses the user's
  existing `opencode auth` credentials. The served OpenAPI (`/doc`) and the
  SDK types are the protocol.
- **Claude** (`src/claude/ClaudeAdapter.ts`): the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk`, imported lazily) runs Anthropic's
  unmodified Claude Code. One streaming `query()` per answering document;
  `listSessions` / `getSessionMessages` / `renameSession` for the library.
  The SDK's `sdk.d.ts` is the protocol — no guessing. Policy limits (Claude
  Code legal and compliance docs): never read, store, or proxy Claude
  credentials, never add a Claude sign-in flow (people sign in with `claude`
  in a terminal), and keep it personal-use — this app must not be shipped to
  others running on their Claude subscriptions.

## State model

- `Snapshot` and `Block` are Effect schemas in `src/shared/contracts.ts`;
  the renderer imports their types through `src/shared/model.ts` (type-only,
  so no Effect runtime ships in the renderer). `Block` is
  `user` | `agent` | `callout` (collapsed tool/diff activity) | `approval`
  (inline Accept/Skip cards, display data only). **Reasoning is never
  rendered** — filter it in the adapter's mapping, not in the UI.
- `ProviderSessionManager` (`src/main/`) is the one place UI state lives:
  each library's catalog and settings, the route, and a runtime per open
  document that keeps streaming when you navigate away. Its pure transitions
  are in `src/main/session/state.ts`.
- Snapshots cross IPC as `SnapshotPatch`es (`src/shared/snapshot-patch.ts`):
  only fields whose reference changed, only changed blocks, and appended
  text as deltas. State must stay immutable — mutating a field or block in
  place means the window never sees the change.
- User blocks carry `images` (paths or URLs, shown via `docs://local/…`) and
  `skills` (names, shown as smart chips). Typing `@` in the composer picks a
  skill from `snapshot.skills`.
- The UI branches on `snapshot.capabilities`, never on provider names.
  Optimistic user echoes reconcile with the server's message (`replaces`),
  so a sent message never appears twice.

## Effect conventions (main, preload contracts, providers)

Main and the providers follow T3 Code's Effect style; the renderer stays
plain React.

- Services and layers for long-lived pieces (`ProcessSupervisor`,
  `ProviderRegistry`, `ProviderSessionManager`, `SnapshotPublisher`).
- Lifetimes are `Scope`s (`acquireRelease`, `forkIn`), never manual teardown.
- Every provider call has a deadline (`Effect.timeoutOrElse` →
  `ProviderTimeoutError`); retries and reconnects are `Schedule`s.
- Failures are the tagged errors in `src/provider/errors.ts`; their
  `message` is the Docs-style sentence the banner shows.
- Commands are decoded with their schema at the IPC boundary.
- Tests use `@effect/vitest` and `TestClock`, against fakes that replace only
  the process boundary (`FakeCodex`, `FakeOpenCode`, `FakeClaude`).
- Don't mix styles: new main/provider code is Effect, not promise chains.

## Project structure

Entry files stay thin — they compose, never hold UI:

- `src/main/index.ts` only boots: it names the app and turns on the compile
  cache, then imports `app.ts`. `app.ts` only wires: window, menu, IPC,
  provider sessions. Logic lives in sibling modules
  (`ProviderSessionManager.ts`, `SnapshotPublisher.ts`, `ipc.ts`, `menu.ts`,
  `window.ts`).
- `src/renderer/src/main.tsx` mounts `<App/>` and imports styles. `app.tsx`
  only switches Home vs Document. Actual UI lives in `components/`:
  - `components/<feature>/` — one folder per screen (`home/`, `document/`),
    holding that screen's components and its local helpers.
  - `components/layout/` — the shared shell (headers, banners, account menu).
  - `components/ui/` — reusable primitives (menus, popovers, icons, markdown).
- Streaming must cost the same at 300 turns as at 3 (rules in
  `docs/architecture.md` §7). Read blocks with `useBlocks()` and everything
  else with `useShellSnapshot()`. Never read layout (`scrollHeight`,
  `getBoundingClientRect`) on every delta. Keep `.doc-block` rows memoized and
  `content-visibility: auto`.
- `src/renderer/src/styles/` — one CSS file per area (`base`, `home`,
  `document`, `toolbar`, `menus`, `tabs`) joined by `index.css`. Never
  rename a class to move it; move the rule block as-is.
- Providers live in `src/<provider>/`: the adapter (orchestration: calls,
  deadlines, events), a pure `mapping.ts`, and a `Fake<Name>.ts` for tests
  and demo mode. Shared provider plumbing is in `src/provider/`; vendored
  third-party code is in `src/vendor/` with its license header.

House rules: keep files focused on one responsibility; split a file when it
stops reading as one idea, not at a line count. Tests and stylesheets are
organized by area. No behavior changes during a move (same exports, same
`data-testid` hooks, same styles). Add an abstraction when it removes real
duplication or a real bug class (the adapter interface, the supervisor) and
explain it in `docs/architecture.md`; otherwise prefer the plain version.
Before building a piece, check T3 Code for an existing pattern and prefer
reusing it (keep its MIT header; see THIRD_PARTY_NOTICES.md). Delete dead
code on sight; don't comment it out, don't leave TODO shims.

## Docs-fidelity rules

- Page text is Arial 11pt (`--font-page`), UI chrome is the system Docs
  stack (`--font-ui`). User questions and agent answers share the body
  scale — a question is a section with a separator, not a giant heading.
- Turns are separated like document sections; an outline rail lists the
  questions and jumps to them (mirrors Docs' "Document tabs" / headings
  panel in the reference screenshots).
- Match `screenshots/` references (real Google Docs home grid, home list
  grouped by recency, editor with tabs panel + formatting toolbar) before
  inventing new chrome. List view groups visible docs by recency
  (Today / Yesterday / Previous 7 days / Previous 30 days). Projects are
  browsable folders with a location filter and a scoped New document action.

## Commands

```bash
pnpm install
pnpm dev          # Electron app with Vite HMR
pnpm test         # vitest: session/protocol + renderer UI tests
pnpm typecheck    # effect-tsgo: tsc + Effect diagnostics (unrun Effects, bare yield)
pnpm lint         # oxlint (T3 Code's rules + floating promises)
pnpm knip         # unused files, exports, dependencies
pnpm fmt          # oxfmt; pnpm fmt:check verifies it
pnpm check        # typecheck + lint + fmt:check + knip + test + build, as CI runs it
pnpm protocol     # regenerate the vendored Codex schemas from the installed CLI
pnpm screenshot   # PNGs of home + document with a fake session
```

`HIDEGPT_FAKE=1` runs every library's real adapter against its in-process
fake (`src/main/demo.ts`, fictional documents only) — use it for UI work,
screenshots and the bench.

## Working agreements

- Small commits on a numbered branch, PR to `main`, no force-pushes.
- Renderer tests use `data-testid` hooks (`app`, `new-doc`, `home-search`,
  `thread-<id>`, `composer`, `menu-file`, …) — keep them working.
- No ChatGPT.com scraping, no protocol guessing. If a method isn't in the
  generated schemas (Codex), the served OpenAPI / SDK types (OpenCode), or
  `sdk.d.ts` (Claude), it doesn't exist.
- After changes: `pnpm check`, plus `pnpm screenshot` for UI changes. Suppress a
  lint rule only with a reason: `// oxlint-disable-next-line <rule> -- <why>`.
