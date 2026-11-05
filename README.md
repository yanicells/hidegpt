# HideGPT

A native macOS Google Docs–looking client for your own AI subscriptions
(Codex, OpenCode, and Claude).

It is an Electron app. The main process talks to provider subprocesses that
reuse your existing logins, and the window is a Docs costume over them:

- **Codex**: spawns `codex app-server` (JSON-RPC over stdio, no `jsonrpc`
  field) and shares `~/.codex` with the Codex CLI and ChatGPT desktop app.
- **OpenCode**: spawns `opencode serve` on 127.0.0.1 (REST + SSE) and uses
  your existing `opencode auth` credentials.
- **Claude**: uses the Claude Agent SDK, which runs Anthropic's unmodified
  Claude Code binary with your own Claude login. Sign in once with `claude`
  in a terminal; Docs never reads or stores Claude credentials. For personal,
  individual use only: Anthropic does not allow offering Claude sign-in or
  subscription limits to other people through a third-party app.

Switch libraries from the Google account (avatar) menu at the top right, on the home page or inside a document. Each library has its own documents and projects. Provider names stay out of sight until that menu opens. Cloud ChatGPT Chat / Cloud Work are out of documented scope.

```bash
pnpm install
pnpm dev
```

| Script | What it does |
|---|---|
| `pnpm dev` | Electron app with Vite HMR |
| `pnpm test` | Session protocol tests plus renderer UI tests |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm protocol` | Regenerate app-server TypeScript types from the installed CLI |
| `pnpm screenshot` | Home grid/list, folder picker, open menus, and desktop/narrow editor PNGs using fictional content |

**Blank document** or a template creates an "Untitled document" right away, like Docs;
rename it from the title field. Projects are folders. The **Owned by** menu on the home
page filters documents by folder, and new documents go into the folder it shows. The
folder icon (**Open file picker**) browses every folder, including empty ones, and
**New folder** adds a project by choosing its name and directory. OpenCode projects use
Git folders.

**My Drive** (no folder) starts in `~/.codex/threads` for Codex or your home folder for
OpenCode, without inheriting the last document's project. Templates place a starter
in the composer; they never send it automatically.

The toolbar keeps the Docs appearance. The style menu (**Normal text**, **Title**,
**Heading 1**…) selects the model; **Options** at its bottom searches the full list.
The font (**Arial**) selects effort, the size (**11**) selects speed, and
**Editing / Suggesting / Viewing** selects the collaboration mode. Available choices
come from the provider.

Tool activity and labeled progress messages are hidden by default. Turn on
**View → Show non-printing characters** to see them; the choice persists across
launches. Answers and approval requests always stay visible; reasoning is always
excluded, including OpenCode streaming deltas.

Opening a document shows immediate, cancellable feedback. Recent turns load first;
**Load earlier** retrieves the rest while preserving the reading position. Streaming
updates are batched at 32 ms, completed answers are memoized, and independent
catalog requests run in parallel. OpenCode reconnects dropped event streams and
reloads the active document and its running status.

## Provider compatibility

Checked on 6 September 2026 against Codex CLI **0.153.0** and OpenCode **1.18.27**.
Codex types are regenerated from the installed CLI. Project creation and explicit
thread project assignment use the generated `project/create` and `thread/start`
schemas. Projects use the current recency sort and paginated catalog.

OpenCode requests were checked against its locally served `/doc` OpenAPI schema:
project names/worktrees, session creation with `directory`, session rename,
status, `/global/event` envelopes, and `/experimental/session` for the cross-project catalog.
Read-only live checks confirmed the global OpenCode catalog and folder matching for older Codex threads without explicit project IDs. Account subscriptions and generation were
not exercised by the fake-session tests.

References: [Codex App Server](https://learn.chatgpt.com/docs/app-server),
[OpenCode Server](https://opencode.ai/docs/server/).

Styling uses Tailwind CSS 4 through its [Vite plugin](https://tailwindcss.com/docs/installation/using-vite).
Shared area selectors use `@apply`; new controls use utilities directly. Specialized
paper, ruler, Markdown, and Electron window styles remain in the area stylesheets.
