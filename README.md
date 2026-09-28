# HideGPT

A native macOS Google Docs–looking client for your own AI subscriptions
(Codex and OpenCode).

It is an Electron app. The main process talks to provider subprocesses that
reuse your existing logins, and the window is a Docs costume over them:

- **Codex**: spawns `codex app-server` (JSON-RPC over stdio, no `jsonrpc`
  field) and shares `~/.codex` with the Codex CLI and ChatGPT desktop app.
- **OpenCode**: spawns `opencode serve` on 127.0.0.1 (REST + SSE) and uses
  your existing `opencode auth` credentials.

Switch libraries using **Codex / OpenCode** on the home page. Each library has its own documents and projects. The **Editing** toolbar menu and **Tools** menu also switch providers. Cloud ChatGPT Chat / Cloud Work are out of documented scope.

```bash
bun install
bun run dev
```

| Script | What it does |
|---|---|
| `bun run dev` | Electron app with Vite HMR |
| `bun run test` | Session protocol tests plus renderer UI tests |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run protocol` | Regenerate app-server TypeScript types from the installed CLI |
| `bun run screenshot` | Home grid/list, project, creation dialog, and desktop/narrow editor PNGs using fictional content |

Choose **Blank document** or a template to name a document and select its location.
Projects are browsable folders, including empty projects. Opening a project remembers
that location when you return from a document; **New document** inside it preselects the project.
Use **Add project** to choose its name and folder. OpenCode projects use Git folders;
other directories work through **Location → Choose folder**.

**My documents · No project** starts in `~/.codex/threads` for Codex or your home
folder for OpenCode, without inheriting the last document's project. Templates
place a starter in the composer; they never send it automatically.

The toolbar keeps the Docs appearance: **Normal text** selects the model,
**Arial** selects effort, **11** selects speed, and **Editing** selects the provider.
Available choices come from the provider. Account details stay in menus.

Use **View → Output only** to hide tool activity and labeled progress messages.
This preference persists across launches. Answers and approval requests remain visible;
reasoning is always excluded, including OpenCode streaming deltas.

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
