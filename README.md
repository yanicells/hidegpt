# HideGPT

A native macOS Google Docs–looking client for your own AI subscriptions
(Codex, OpenCode, and Claude).

It is an Electron app. The main process talks to provider subprocesses that
reuse your existing logins, and the window is a Docs costume over them:

- **Codex**: spawns `codex app-server` (JSON-RPC over stdio, no `jsonrpc`
  field) and shares `~/.codex` with the Codex CLI and ChatGPT desktop app.
- **OpenCode**: spawns `opencode serve` on 127.0.0.1 (REST + SSE, behind a
  random per-launch password) and uses your existing `opencode auth`
  credentials.
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

`pnpm install` also points Git at `.githooks/`, so each commit runs oxlint on the
staged files and knip on the repo.

| Script | What it does |
|---|---|
| `pnpm dev` | Electron app with Vite HMR |
| `pnpm test` | Provider adapter, session manager, and renderer UI tests |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | oxlint, with T3 Code's rules |
| `pnpm knip` | Unused files, exports, and dependencies |
| `pnpm check` | Typecheck, lint, knip, and tests: what CI runs |
| `pnpm fmt` | oxfmt (not yet applied repo-wide) |
| `pnpm protocol` | Regenerate the Codex app-server schemas from the installed CLI |
| `pnpm protocol --check` | Fail if the committed schemas no longer match the installed CLI |
| `pnpm screenshot` | Home grid/list, folder picker, open menus, a streaming reply and a suggestion, and desktop/narrow editor PNGs using fictional content |

**Blank document** or a template creates an "Untitled document" right away, like Docs;
rename it from the title field. Projects are folders. The folder icon (**Open file
picker**) browses every folder, including empty ones; opening one titles the home list
with its name, and new documents go into it. **Owned by anyone** goes back to every
document. **New folder** adds a project: type its name, then pick its directory after
**Create**. OpenCode projects use Git folders.

With no folder open, a new document starts in `~/.codex/threads` for Codex or your home folder for
OpenCode, without inheriting the last document's project. Templates place a starter
in the composer; they never send it automatically.

The toolbar keeps the Docs appearance. The style menu (**Normal text**, **Title**,
**Heading 1**…) selects the model; hover a style to see which model it is.
The font (**Arial**) selects effort, the size (**11**) selects speed, and
**Editing / Suggesting / Viewing** selects the collaboration mode. Available choices
come from the provider.

Tool activity and labeled progress messages are hidden by default. Turn on
**View → Show non-printing characters** to see them; the choice persists across
launches. Answers and approval requests always stay visible; reasoning is always
excluded, including OpenCode streaming deltas.

Opening a document shows immediate, cancellable feedback. Recent turns load first;
**Load earlier** retrieves the rest while preserving the reading position. A document
keeps answering when you go back to Home or open another one, and its approvals wait
for you there. Streaming text crosses to the window as deltas in 32 ms frames.
A provider that crashes restarts with backoff and the document on screen reloads; every
request has a deadline, so nothing stays on "Working…". See
[docs/architecture.md](docs/architecture.md) for how this is built.

## Provider compatibility

Checked on 5 November 2026 against Codex CLI **0.166.0**, OpenCode **1.18.34**
(through `@opencode-ai/sdk` 1.19), and Claude Code **2.1.318** (through
`@anthropic-ai/claude-agent-sdk` 0.3.283). No check sent a prompt to a model.

- **Codex**: the vendored client's schemas are regenerated from the installed CLI
  (`pnpm protocol`). Project creation and thread project assignment use the
  generated `project/create` and `thread/start` schemas.
- **OpenCode**: requests go through the official SDK client and were checked
  against the locally served `/doc` OpenAPI schema: `/experimental/session` for
  the cross-project catalog (cursor paging), session create/rename/status,
  `prompt_async` with a client `messageID`, permission and question replies, and
  `/global/event` envelopes and heartbeats.
- **Claude**: the SDK's `sdk.d.ts` is the contract: `listSessions`,
  `getSessionMessages`, `renameSession`, streaming-input `query()`, and
  `initializationResult()` for models, commands, and login status.

References: [Codex App Server](https://learn.chatgpt.com/docs/app-server),
[OpenCode Server](https://opencode.ai/docs/server/),
[Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview).

Styling uses Tailwind CSS 4 through its [Vite plugin](https://tailwindcss.com/docs/installation/using-vite).
Shared area selectors use `@apply`; new controls use utilities directly. Specialized
paper, ruler, Markdown, and Electron window styles remain in the area stylesheets.

## Acknowledgements

[T3 Code](https://github.com/pingdotgg/t3code) is a major inspiration for
HideGPT's architecture and the source of reused code. The Effect client for
`codex app-server` in `src/vendor/effect-codex-app-server/` is vendored from
T3 Code, and the provider adapters, session manager, process supervision, and
replay tests follow its patterns, as do smaller pieces of the OpenCode and Claude
adapters (each marked in place). In the window, the cached Markdown renderer and
streaming block splitter come from T3 Code's web app, and the store's selectors
follow its thread-detail state. The tooling follows T3 Code too: the oxlint rules,
knip config, CI workflow, and pre-commit checks are adapted from its setup.
T3 Code is MIT licensed, Copyright (c) 2026
T3 Tools Inc.; the full notice is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
