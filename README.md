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

`pnpm install` also points Git at `.githooks/`, so each commit formats and lints
the staged files. It does this by setting `core.hooksPath`, which replaces any hooks path
you had set, in the Git config that every worktree of this repository shares.

In VS Code, install the recommended extensions (oxc and TypeScript Native Preview) to see
the Effect diagnostics as you type and format on save: `.vscode/settings.json` points the
TypeScript 7 language server at `.vscode/tsdk/tsgo`, which runs `effect-tsgo`'s binary from
`node_modules`. The `typescript` (5.x) devDependency now serves editors without that
extension only; no script runs `tsc`.

| Script                         | What it does                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                     | Electron app with Vite HMR                                                                                                            |
| `pnpm test`                    | Provider adapter, session manager, and renderer UI tests                                                                              |
| `pnpm typecheck`               | TypeScript plus Effect diagnostics (`effect-tsgo`), e.g. an Effect that is built but never run                                        |
| `pnpm typecheck:effect-strict` | T3 Code's full Effect rule set; not yet clean, so not gating                                                                          |
| `pnpm lint`                    | oxlint with T3 Code's rules, plus floating promises                                                                                   |
| `pnpm knip`                    | Unused files, exports, and dependencies                                                                                               |
| `pnpm check`                   | Typecheck, lint, format check, knip, tests, and build: what CI runs                                                                   |
| `pnpm fmt`                     | Format with oxfmt; `pnpm fmt:check` verifies it in CI                                                                                 |
| `pnpm protocol`                | Regenerate the Codex app-server schemas from the installed CLI                                                                        |
| `pnpm protocol --check`        | Fail if the committed schemas no longer match the installed CLI                                                                       |
| `pnpm screenshot`              | Home grid/list, folder picker, open menus, a streaming reply and a suggestion, and desktop/narrow editor PNGs using fictional content |
| `pnpm fidelity:shots`          | Hidden, deterministic captures plus layout dumps for the fidelity checks (see [Fidelity checks](#fidelity-checks))                    |
| `pnpm fidelity:check`          | Score those captures against the Google Docs targets, one PASS/FAIL line per metric                                                   |
| `pnpm fidelity:diff`           | Compare two captures pixel by pixel                                                                                                   |
| `pnpm dist`                    | Package a macOS `.dmg` into `dist/` (see [Packaging](#packaging))                                                                     |

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

## Fidelity checks

`pnpm fidelity:shots` builds the app and drives it with the fake providers in
windows that are never shown: no Dock icon, no focus change (on macOS it launches
through `open -g -n -W`). Each phase runs in its own Electron, in parallel:

| Phase    | What it captures                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `core`   | Home, an empty, a reference and the demo document, streaming, suggestions, the error banner; at 1280, 1402, 1470, 1680, 1920 and 760 wide |
| `states` | Hovers, focus, every menu, dialogs, banners and narrow widths at 1402                                                                     |
| `motion` | Frame-by-frame streaming and opening, with layout-shift logs (timing-dependent, so not compared)                                          |

```sh
pnpm fidelity:shots                    # core and states (about 2 minutes) -> screenshots/fidelity/
pnpm fidelity:shots --phase motion     # or any comma-separated list; --no-build reuses out/
pnpm fidelity:check                    # every metric in scripts/fidelity/targets.json
pnpm fidelity:check --failing --only toolbar
```

To prove a change moves no pixels (or only the ones it should), capture both
sides into their own directories and compare them:

```sh
git switch main && pnpm fidelity:shots --out tmp/before
git switch my-branch && pnpm fidelity:shots --out tmp/after
pnpm fidelity:diff tmp/before tmp/after     # "137 identical", or each screen that changed
pnpm fidelity:diff tmp/before tmp/after --out tmp/overlays   # red overlays of the changes
```

A phase still running after `--timeout` seconds (600 by default) is killed, as
is every phase on Ctrl-C.

Captures are 2x PNGs with a JSON dump beside each: element boxes, computed fonts
and colours, the faces Chromium actually drew, and the selectors `targets.json`
probes. The clock, time zone, locale and colour scheme are pinned, and pages are
rastered on the CPU (GPU raster antialiases icons slightly differently each run),
so two runs on the same commit are pixel-identical. CPU and GPU raster draw page
text identically; icon edges can differ by a level or two from what the app shows
on screen. Targets hold the Google Docs values from the
UI audit. A selector may change when markup changes; a target value may not.

The check and diff tools are Python. With [uv](https://docs.astral.sh/uv/)
installed (`brew install uv`) the `pnpm` scripts fetch their dependencies
(Pillow, NumPy) on first run. Without uv, `pip install pillow numpy` and run
`python3 scripts/fidelity/check.py` directly.

## Packaging

`pnpm dist` builds the app and packages it as **Docs** (`Docs-<version>-<arch>.dmg`
in `dist/`), with a plain document icon and the bundle id
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

An app opened from Finder doesn't get your terminal's PATH, so at launch the
packaged app asks your login shell for it (`$SHELL -ilc`, then your account's
shell, then `/bin/zsh`, within 4 seconds in all). That way `codex` and `opencode`
installed under nvm, Volta, fnm, npm globals or `~/.opencode/bin` are found.
The window opens meanwhile; only provider starts wait for the answer. Homebrew,
`~/.bun/bin` and `~/.local/bin` stay as the fallback.

**Signing and notarizing are off unless their variables are set.** With none, the
app is ad-hoc signed: it opens on your own Mac, and on another Mac only after
**Open Anyway** in System Settings → Privacy & Security (or
`xattr -dr com.apple.quarantine Docs.app`).

| Variables                                                                                                                                                                  | Effect                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `CSC_LINK` (a `.p12`) + `CSC_KEY_PASSWORD`, or `CSC_NAME` (a keychain identity)                                                                                            | Sign with a Developer ID, with the hardened runtime and `build/entitlements.mac.plist` |
| `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_KEYCHAIN` + `APPLE_KEYCHAIN_PROFILE` | Also notarize (only for a signed build)                                                |

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
follow its thread-detail state. The tooling follows T3 Code too: the oxlint rules,
Effect diagnostics, knip config, CI workflow, pre-commit checks, and VS Code setup are adapted
from its setup.
T3 Code is MIT licensed, Copyright (c) 2026
T3 Tools Inc.; the full notice is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
