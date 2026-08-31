# HideGPT

A macOS Google Docs–looking client for your local ChatGPT Work/Codex agent.

It wraps `codex app-server` (JSON-RPC over stdio) and uses the same `~/.codex` home as the Codex CLI and ChatGPT desktop app. Cloud ChatGPT Chat / Cloud Work are out of documented scope.

```bash
bun install
bun run dev
```

| Script | What it does |
|---|---|
| `bun run dev` | Desktop app with hot remount |
| `bun run test` | Unit tests plus GPU UI tests |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run protocol` | Regenerate app-server TypeScript types from the installed CLI |
| `bun run screenshot` | PNG of the live window |

New documents use `~/.codex/threads` unless you pick **File → Open folder**.
