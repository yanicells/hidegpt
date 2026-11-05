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
    (`makeMessageIds`, from `packages/provider-opencode/src/server/adapter.ts`)
    and reading the server's "listening" line (`parseServerUrl`, from
    `packages/provider-opencode/src/server/OpenCodeRuntime.ts`).
  - `src/opencode/mapping.ts`: `readableProviderError`, from
    `packages/provider-opencode/src/server/providerErrorMessage.ts`.
  - `src/claude/ClaudeAdapter.ts`: the streaming-input query per document, the
    capabilities probe that sends no prompt, and approvals as one Deferred per
    request, from `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`
    and `apps/server/src/provider/ClaudeProvider.ts`.
  - `src/claude/mapping.ts`: `isSignedIn` and `resultError`, from the same two
    files.
  - `src/main/index.ts`: quitting after shutdown (cancel the first
    `before-quit`, close every scope, then quit; exit if shutdown stalls),
    from `apps/desktop/src/app/DesktopLifecycle.ts`.
  - `src/renderer/src/session-bridge.ts` and `components/document/Approval.tsx`:
    failed commands kept as a local error and replies tracked while they are
    on their way, from `apps/web/src/components/chat/usePendingThreadRequests.ts`
    and `ComposerPendingApprovalActions.tsx`.
  - `src/renderer/src/components/layout/Banners.tsx`: banner dismissal keyed by
    the error text, from `apps/web/src/components/chat/ThreadErrorBanner.tsx`.
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
