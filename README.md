# HideGPT

A native macOS Google Docs–looking client for your local ChatGPT Work/Codex agent.

It is an Electron app. The main process speaks to `codex app-server` (JSON-RPC over stdio, no `jsonrpc` field) and uses the same `~/.codex` home as the Codex CLI and ChatGPT desktop app. Cloud ChatGPT Chat / Cloud Work are out of documented scope.

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
