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

Switch libraries using **Codex / OpenCode / Claude** on the home page. Each library has its own documents and projects. The **Editing** toolbar menu and **Tools** menu also switch providers. Cloud ChatGPT Chat / Cloud Work are out of documented scope.

```bash
pnpm install
pnpm dev
```

| Script | What it does |
|---|---|
| `pnpm dev` | Electron app with Vite HMR |
| `pnpm test` | Provider adapter, session manager, and renderer UI tests |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm protocol` | Regenerate the Codex app-server schemas from the installed CLI |
| `pnpm screenshot` | Home grid/list, project, creation dialog, and desktop/narrow editor PNGs using fictional content |
| `pnpm dist` | Package a macOS `.dmg` and `.zip` into `dist/` (see [Packaging](#packaging)) |

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
**Load earlier** retrieves the rest while preserving the reading position. A document
keeps answering when you go back to Home or open another one, and its approvals wait
for you there. Streaming text crosses to the window as deltas in 32 ms frames.
A provider that crashes restarts with backoff and the document on screen reloads; every
request has a deadline, so nothing stays on "Working…". See
[docs/architecture.md](docs/architecture.md) for how this is built.

## Packaging

`pnpm dist` builds the app and packages it as **Docs** (`Docs-<version>-<arch>.dmg`
and `.zip` in `dist/`), with a plain document icon and the bundle id
`app.docs.desktop`. It needs Node 22.18 or later. Before packaging it checks
that the preload loads in Electron's sandbox (`scripts/verify-preload-bundle.ts`).

**Shared builds leave Claude out.** Anthropic doesn't allow offering Claude
sign-in or limits to other people through a third-party app, so by default
`pnpm dist` compiles the Claude library out (`PROVIDERS` and the provider
registry drop it) and ships no `node_modules` at all. After packaging it opens
the shipped `app.asar` and fails if it holds any `node_modules`, anything from
`@anthropic-ai`, or Claude code inlined into a chunk
(`scripts/shared-build-guard.ts`); a failed build leaves no `.dmg` behind. That
build is the one to give friends. For your own copy:

```bash
HIDEGPT_PERSONAL=1 pnpm dist   # dist/personal/Docs-<version>-<arch>-personal.dmg, with Claude
```

A personal build goes to its own folder with `-personal` in its name, so it
can't be mistaken for the shared one. It ships only the Claude SDK, with its
binary unpacked next to `app.asar` so it can be spawned.

Running from source (`pnpm dev`, `pnpm start`, `pnpm screenshot`, tests) always
includes Claude.

**Signing and notarizing are off unless their variables are set.** With none, the
app is ad-hoc signed: it opens on your own Mac, and on another Mac only after
**Open Anyway** in System Settings → Privacy & Security (or
`xattr -dr com.apple.quarantine Docs.app`).

| Variables | Effect |
|---|---|
| `CSC_LINK` (a `.p12`) + `CSC_KEY_PASSWORD`, or `CSC_NAME` (a keychain identity) | Sign with a Developer ID, with the hardened runtime and `build/entitlements.mac.plist` |
| `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_KEYCHAIN` + `APPLE_KEYCHAIN_PROFILE` | Also notarize (only for a signed build) |

Empty or blank variables count as unset. Without a certificate variable, every
signing and notary variable is dropped before electron-builder runs, and the
keychain is never searched for a certificate.

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
follow its thread-detail state. T3 Code is MIT licensed, Copyright (c) 2026
T3 Tools Inc.; the full notice is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
