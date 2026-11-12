# Third-party notices

HideGPT includes code copied or adapted from the projects below. Each copied
or adapted file carries a header naming its source.

## T3 Code

- Source: https://github.com/pingdotgg/t3code (commit 8a14762c)
- What: `src/vendor/effect-codex-app-server/` (the Effect client, JSON-RPC
  protocol, replay harness, errors, stdio helpers, mock peer, and schema
  generator for `codex app-server`), and patterns adapted throughout
  `src/provider/` and `src/main/` (provider adapters, session manager,
  process supervision, replay tests). Smaller adaptations, each marked in
  place:
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
  - `src/renderer/src/components/ui/markdownRenderer.ts` and
    `markdownStreamBlocks.ts`, with their tests: the cached Markdown renderer and
    the streaming block splitter, from `apps/web/src/components/chat/`.
  - `src/renderer/src/components/document/useFollowBottom.ts`: letting go of the
    bottom on upward input (wheel, up keys, a scrollbar press) unless a nested
    box scrolls, and on any other upward scroll (the upward-scroll detector),
    from `apps/web/src/components/chat/timelineViewport.ts` and
    `timelineScrollTarget.ts`.
  - `src/main/logging/` (commit 5c6f2f12): the rotating file sink, from
    `packages/shared/src/logging.ts` (`makeAsyncRotatingFileSink`); the main
    NDJSON logger, after `apps/server/src/serverLogger.ts` and
    `observability/Observability.ts`; the provider event log with its batching
    writer and skipped text deltas, after
    `apps/server/src/provider/EventNdjsonLogger.ts`; and logging only defects,
    from `apps/server/src/observability/DefectReporter.ts`, now in
    `src/provider/DefectReport.ts`; and redacting logged causes
    (`src/main/logging/redact.ts`), from `redactCauseCredentials` in
    `packages/shared/src/observability.ts` and its use in
    `apps/server/src/serverLogger.ts`, extended to the home folder, the
    account name, and more credential shapes.
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
