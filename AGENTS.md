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
  (`textarea.composer`, Enter to send). Each question renders as a Docs
  Heading 1 (`h1.doc-question`), agent turns as Markdown body
  (`components/ui/Markdown.tsx`: T3's cached unified renderer with
  remark-gfm, loaded after Home paints). The "Document
  tabs" panel lists those headings, with answer sections nested under each
  (`document/outline.ts`), and jumps to them.
- **Stealth rule:** nothing on screen may read as AI, and no provider or
  model name is visible until a menu opens. The controls wear Docs costumes:
  models are the style menu's slots ("Normal text", "Title", "Heading 1"…;
  real names only in row tooltips, and Options holds Docs' own rows), effort
  is the font menu,
  service tier is the font size, collaboration mode is Editing/Suggesting/Viewing,
  and the provider switch lives in the Google account (avatar) menu.
  Tool activity is hidden by default and shown with View → "Show
  non-printing characters". Approvals are Docs suggestion cards, and errors use
  Docs' own wording with the raw message behind "Details". Usage meters and connection banners do not belong
  in the page — surface them under Tools, if at all. Plan mode is not offered
  on either provider.
  The banned words live in `src/shared/stealth.ts`; `src/main/session/stealthFilter.ts`
  puts every snapshot into Docs wording before it leaves main. `pnpm test` checks the
  renderer's visible strings, `pnpm stealth:scan` the built bundle (exceptions, with
  reasons, in `scripts/stealth-allow.json`), and `pnpm dist` the packaged app.

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
  never invent protocol methods. `pnpm protocol --check` fails when they no
  longer match the installed CLI. Wire-to-model mapping (items, approvals,
  catalog) lives in `src/codex/mapping.ts`.
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
  (green suggested text in the page with a Docs suggestion card beside it, ✓/✗). **Reasoning is never rendered** — filter it
  in the adapter's mapping, not in the UI.
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
  `message` is the Docs-style sentence the banner shows. A defect never
  shows its raw text: it goes through `describeFailure` or `reportDefect`
  (`src/provider/DefectReport.ts`), which log it.
- Diagnostics go through `Effect.log*` (written to `userData/logs`), not
  `console`. Never log prompt or answer text, titles, sign-in links,
  credentials, or a provider's error text; log `errorLogFields` instead
  (`docs/architecture.md` §1).
- Every IPC channel is a row in the `Ipc*` tables in `src/shared/contracts.ts`;
  main decodes its payload at the boundary and the preload's types derive from it.
- Tests use `@effect/vitest` and `TestClock`, against fakes that replace only
  the process boundary (`FakeCodex`, `FakeOpenCode`, `FakeClaude`), plus replay
  fixtures recorded from the real CLIs (docs/replay-fixtures.md). Never set
  `HIDEGPT_RECORD_TURNS=1`: only the owner records turns.
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
    Menus, popovers, dialogs and tooltips wrap `@base-ui/react` in
    `ui/menu.tsx`, `ui/popover.tsx`, `ui/dialog.tsx` and `ui/tooltip.tsx`
    (adapted from T3 Code, see `THIRD_PARTY_NOTICES.md`); `ui/MenuPanel.tsx`
    fills a menu from `Item` rows. Hover labels are `<Tip label>` (Docs' dark
    tooltip), never a native `title` attribute. Icons are Material Symbols paths in `ui/symbols.ts`, generated by
    `scripts/material-symbols.py`; render them with `<MIcon name>`.
  - Fonts are npm `@fontsource` packages imported in `fonts.ts` (Google Sans
    Flex for chrome, Roboto for text, and latin-400 faces of Docs' font list
    for the font menu), never a CDN.
- Streaming must cost the same at 300 turns as at 3 (rules in
  `docs/architecture.md` §7). Read blocks with `useBlocks()` and everything
  else with `useShellSnapshot()`. Never read layout (`scrollHeight`,
  `getBoundingClientRect`) on every delta. Keep `.doc-block` rows memoized and
  `content-visibility: auto`.
- `src/renderer/src/styles/` — one CSS file per area (`base`, `home`,
  `templates`, `toolbar`, `document`, `approvals`, `composer`, `menus`,
  `tabs`, `dialogs`) joined by `index.css`. Never
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

- Page text is Arial 11pt, line-height 1.35 (`--font-page`); UI chrome is
  Google Sans Flex (`--font-ui`). Use Docs' own heading scale: a question is
  Heading 1 (20pt, weight 400, 20pt above / 6pt below); answer `#`–`###`
  are Heading 2, `####` Heading 3, and so on down Docs' scale. No separators between turns; headings structure the page.
- The "Document tabs" panel (280px, collapsible) lists the Heading 1s with
  answer sections indented under them, and jumps to them, like Docs' outline.
- Match the live Docs references (`references/`: home grid, list grouped by
  recency, editor with tabs panel, toolbar and menus) before inventing new
  chrome. Measured sizes live as comments next to each rule in `styles/`.
  List view groups visible docs by recency (Today / Yesterday / Previous
  7 days / Previous 30 days).
- Don't invent screens Docs doesn't have. Blank document creates "Untitled
  document" at once (no naming dialog). Projects are folders, opened from
  the Drive-style "Open a file" picker (which also creates them); the open
  folder titles the home list and scopes New document. "Owned by" keeps Docs'
  three choices, and "Owned by anyone" leaves the folder.

## Commands

```bash
pnpm install
pnpm dev          # Electron app with Vite HMR
pnpm test         # vitest: session/protocol + renderer UI tests
pnpm typecheck    # tsc --noEmit
pnpm lint         # oxlint (T3 Code's rules)
pnpm knip         # unused files, exports, dependencies
pnpm check        # typecheck + lint + knip + test, as CI runs it
pnpm protocol     # regenerate the vendored Codex schemas from the installed CLI
pnpm protocol --check  # fail if the committed schemas drift from the installed CLI
pnpm record:codex library   # re-record a no-prompt replay fixture (also record:claude)
pnpm screenshot   # PNGs of home + document with a fake session
pnpm dist         # package dist/Docs-*.dmg; HIDEGPT_PERSONAL=1 adds Claude, in dist/personal/
```

`HIDEGPT_FAKE=1` runs every library's real adapter against its in-process
fake (`src/main/demo.ts`, fictional documents only) — use it for UI work,
screenshots and the bench.

`HIDEGPT_PERSONAL` is a build-time flag (`__HIDEGPT_PERSONAL__`, read only
through `PERSONAL_BUILD` in `src/shared/labels.ts`). Runs from source set it;
`pnpm dist` clears it unless `HIDEGPT_PERSONAL=1`, which drops Claude from
`PROVIDERS` and from the bundle. Gate any new Claude import on it the same way
`ProviderRegistry.ts` does, or the shared build check (`scripts/shared-build-guard.ts`) fails.

## Working agreements

- Small commits on a numbered branch, PR to `main`, no force-pushes.
- Renderer tests use `data-testid` hooks (`app`, `new-doc`, `home-search`,
  `thread-<id>`, `composer`, `menu-file`, …) — keep them working.
- No ChatGPT.com scraping, no protocol guessing. If a method isn't in the
  generated schemas (Codex), the served OpenAPI / SDK types (OpenCode), or
  `sdk.d.ts` (Claude), it doesn't exist.
- After changes: `pnpm check`, plus `pnpm screenshot` for UI changes. Suppress a
  lint rule only with a reason: `// oxlint-disable-next-line <rule> -- <why>`.
