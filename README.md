# HideGPT

A native macOS Google Docs–looking client for your own AI subscriptions
(Codex and OpenCode).

It is an Electron app. The main process talks to provider subprocesses that
reuse your existing logins, and the window is a Docs costume over them:

- **Codex**: spawns `codex app-server` (JSON-RPC over stdio, no `jsonrpc`
  field) and shares `~/.codex` with the Codex CLI and ChatGPT desktop app.
- **OpenCode**: spawns `opencode serve` on 127.0.0.1 (REST + SSE) and uses
  your existing `opencode auth` credentials.

Switch providers from the toolbar chip or **Tools → Use Codex / Use
OpenCode**. Cloud ChatGPT Chat / Cloud Work are out of documented scope.

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
| `bun run screenshot` | PNG of home and an open document (uses a fake Codex session) |

New documents use `~/.codex/threads` unless you pick **File → Open folder**.
