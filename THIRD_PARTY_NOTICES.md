# Third-party notices

HideGPT includes code copied or adapted from, or assets bundled from, the
projects below. Each copied or adapted file carries a header naming its source.

## T3 Code

- Source: https://github.com/pingdotgg/t3code (commit 8a14762c)
- What: `src/vendor/effect-codex-app-server/` (the Effect client, JSON-RPC
  protocol, replay harness, errors, stdio helpers, mock peer, and schema
  generator for `codex app-server`), and patterns adapted throughout
  `src/provider/` and `src/main/` (provider adapters, session manager,
  process supervision, replay tests). Smaller adaptations, each marked in
  place:
  - `src/vendor/effect-codex-app-server/*.test.ts` and `_internal/*.test.ts`:
    the package's own tests, plus the newer `_internal/stdio.ts` that keeps a
    launcher error ahead of an exit summary, from commit 5c6f2f12.
  - Replay fixtures, from commit 5c6f2f12: `scripts/record-codex-replay.ts`
    and `src/codex/replay.ts` (the recording protocol logger), from
    `apps/server/scripts/record-codex-app-server-replay-fixture.ts`;
    `scripts/record-claude-replay.ts` and `src/claude/replay.ts` (recording
    and replaying Agent SDK calls), from
    `apps/server/scripts/record-claude-agent-sdk-replay-fixture.ts` and
    `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts`;
    and the scrubbing in `src/provider/replayFixture.ts`, from
    `apps/server/scripts/codexReplayRecordingRecords.ts`.
  - `src/provider/randomUuid.ts`: v4 UUIDs drawn from Effect's `Random`, from
    `packages/provider-core/src/server/randomUuid.ts` (commit 5c6f2f12).
  - `src/opencode/OpenCodeAdapter.ts`: message ids in OpenCode's format
    (`makeMessageIds`) and a set of busy sessions like `busySessionIds`, used
    here so a repeated busy status starts no new turn, both from
    `packages/provider-opencode/src/server/adapter.ts`; and reading the
    server's "listening" line (`parseServerUrl`, from
    `packages/provider-opencode/src/server/OpenCodeRuntime.ts`).
  - `src/opencode/mapping.ts`: `readableProviderError`, from
    `packages/provider-opencode/src/server/providerErrorMessage.ts`.
  - `src/claude/ClaudeAdapter.ts`: the streaming-input query per document, the
    capabilities probe that sends no prompt, and approvals as one Deferred per
    request, from `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`
    and `apps/server/src/provider/ClaudeProvider.ts`.
  - `src/claude/mapping.ts`: `isSignedIn` and `resultError`, from the same two
    files.
  - `src/main/index.ts`: booting through a small entry that turns on Node's
    compile cache before the app loads, from `apps/desktop/src/boot.ts` and
    `apps/desktop/src/compileCache.ts`.
  - `src/main/app.ts`: quitting after shutdown (cancel the first
    `before-quit`, close every scope, then quit; exit if shutdown stalls; open
    no window on activation meanwhile), from
    `apps/desktop/src/app/DesktopLifecycle.ts`.
  - `src/provider/ProcessSupervisor.ts` and `src/provider/ProcessLedger.ts`:
    Claude Code spawned in its own process group with stderr drained
    (`spawnClaudeProcessGroup`) and pid plus start time from `ps`
    (`parseClaudeProcessTable`), and recording a CLI's process tree to stop
    only what is still the same process (`trackDescendants`,
    `claudeDescendants`), from
    `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`; the
    atomic ledger write (`packages/shared/src/atomicWrite.ts`), and one app per
    profile in `src/main/app.ts` (`apps/desktop/src/app/DesktopClerk.ts`), at
    commit 5c6f2f12.
  - `src/main/window.ts` and `window.test.ts` (commit 5c6f2f12): bounded
    reloads after a renderer crash, from `apps/desktop/src/window/DesktopWindow.ts`;
    the CSP response header and serving local files only under allowed roots,
    from `apps/desktop/src/electron/ElectronProtocol.ts`; deny-by-default
    permission handlers, from `apps/desktop/src/preview/BrowserSession.ts`; and
    the test shape of `ElectronProtocol.test.ts` and `ElectronShell.test.ts`.
  - `src/renderer/src/components/layout/RenderErrorBoundary.tsx` (commit
    5c6f2f12): from `apps/web/src/components/RenderErrorBoundary.tsx`.
  - `src/main/ProviderSessionManager.ts` and `src/opencode/OpenCodeAdapter.ts`:
    handling a defect in a long-lived fiber with `Effect.catchCause` and
    re-interrupting on interruption, from
    `packages/provider-opencode/src/server/adapter.ts`.
  - `src/renderer/src/session-bridge.ts` and `components/document/Approval.tsx`:
    failed commands kept as a local error and replies tracked while they are
    on their way, from `apps/web/src/components/chat/usePendingThreadRequests.ts`
    and `ComposerPendingApprovalActions.tsx`.
  - `src/renderer/src/components/layout/Banners.tsx`: banner dismissal keyed by
    the error text, from `apps/web/src/components/chat/ThreadErrorBanner.tsx`.
  - `src/renderer/src/session-bridge.ts`: selector subscriptions that skip
    streamed text, after `packages/client-runtime/src/state/threadDetail.ts`.
  - `src/shared/channels.ts`, the IPC tables in `src/shared/contracts.ts`,
    `src/main/ipc.ts` (with its test) and `src/preload/index.ts`: channel
    names, typed invoke and sync channels, and the preload bridge, from
    `apps/desktop/src/ipc/channels.ts`, `apps/desktop/src/ipc/DesktopIpc.ts`,
    `packages/contracts/src/ipc.ts` and `apps/desktop/src/preload.ts` (commit
    5c6f2f12).
  - `src/shared/snapshot-patch.ts`: `applyPatchOnce`, skipping patches a read
    already includes by sequence number, from
    `apps/web/src/components/guest/guestStream.logic.ts` (commit 5c6f2f12).
  - `src/renderer/src/components/ui/markdownRenderer.ts` and
    `markdownStreamBlocks.ts`, with their tests: the cached Markdown renderer and
    the streaming block splitter, from `apps/web/src/components/chat/`.
  - `src/renderer/src/components/document/useFollowBottom.ts`: letting go of the
    bottom on upward input (wheel, up keys, a scrollbar press) unless a nested
    box scrolls, and on any other upward scroll (the upward-scroll detector),
    from `apps/web/src/components/chat/timelineViewport.ts` and
    `timelineScrollTarget.ts`.
  - `src/renderer/src/components/ui/`: these Base UI wrappers, adapted from
    `apps/web/src/components/ui/` (each keeps a header pointing to its source):

    | HideGPT file             | Adapted from             |
    | ------------------------ | ------------------------ |
    | `closing-positioner.tsx` | `closing-positioner.tsx` |
    | `menu.tsx`               | `menu.tsx`               |
    | `popover.tsx`            | `popover.tsx`            |
    | `dialog.tsx`             | `dialog.tsx`             |
    | `tooltip.tsx`            | `tooltip.tsx`            |

  - Tooling, adapted from T3 Code's repository root (commit 5c6f2f12):
    `.oxlintrc.json` from the `lint` block of `vite.config.ts`; `knip.jsonc`
    from `knip.jsonc`; `.github/workflows/ci.yml` from
    `.github/workflows/ci.yml`; and `lint-staged.config.js` with
    `.githooks/pre-commit` from the `staged` block of `vite.config.ts` and
    `.vite-hooks/pre-commit`.
  - `src/main/logging/` (commit 5c6f2f12): the rotating file sink, from
    `packages/shared/src/logging.ts` (`makeAsyncRotatingFileSink`); the main
    NDJSON logger, after `apps/server/src/serverLogger.ts` and
    `observability/Observability.ts`; the provider event log with its batching
    writer and skipped text deltas, after
    `apps/server/src/provider/EventNdjsonLogger.ts`; and logging only defects,
    from `apps/server/src/observability/DefectReporter.ts`, now in
    `src/provider/DefectReport.ts`.
  - `scripts/dist.ts`, `scripts/builder-config.ts` and
    `scripts/verify-preload-bundle.ts`: the electron-builder config built in
    code, signing only when asked and dropping empty signing variables, and the
    sandboxed preload check, from `scripts/build-desktop-artifact.ts` and
    `apps/desktop/scripts/verify-preload-bundle.mjs` (commit 5c6f2f12).
  - `src/main/loginShellPath.ts`: reading PATH from the login shell between
    markers (`-ilc`, a detached probe with a timeout, clearing a DEBUG trap) and
    merging it ahead of the inherited PATH, from `packages/shared/src/shell.ts`
    and `apps/server/src/os-jank.ts` (commit 5c6f2f12).
- License: MIT

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Material Symbols (Apache-2.0)

https://github.com/google/material-design-icons

`src/renderer/src/components/ui/symbols.ts` holds outlines that
`scripts/material-symbols.py` extracts from the Material Symbols Outlined font.
The full license text is in `src/renderer/src/components/ui/symbols.LICENSE.txt`.

## Fonts (SIL Open Font License 1.1)

Google Sans Flex (`@fontsource-variable/google-sans-flex`) and Roboto
(`@fontsource/roboto`) are installed as npm packages and bundled at build time.
So are the unmodified faces the font menu previews (`src/renderer/src/fonts.ts`):
Amatic SC, Caladea, Carlito, Caveat, Comfortaa, EB Garamond, Lexend, Lobster,
Lora, Merriweather, Montserrat, Nunito, Open Sans, Oswald, Pacifico, Playfair
Display, Roboto Mono and Spectral. Each package ships its license as `LICENSE`.
