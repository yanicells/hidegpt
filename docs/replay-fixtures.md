# Replay fixtures

Replay tests run the real Codex and Claude adapters against conversations
recorded from the real CLIs. The fakes (`FakeCodex`, `FakeClaude`) are written
by hand; a recording is what the CLI actually sent. A replay pins two things:
what the adapter sends, and how it handles the CLI's real answers. It plays
back a fixed recording, so it can't notice a CLI update by itself. Re-record
after updating a CLI (see the end of this page).

The recorders run the app's TypeScript directly with Node, so they need
Node 22.18 or later (`engines` in package.json), as does the app.

| Provider | Fixture                                                                         | Recorder                        | Test                                      |
| -------- | ------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------- |
| Codex    | `src/codex/fixtures/<scenario>.ndjson` (JSON-RPC frames)                        | `pnpm record:codex <scenario>`  | `src/codex/CodexAdapter.replay.test.ts`   |
| Claude   | `src/claude/fixtures/<scenario>.ndjson` (Agent SDK calls, answers and messages) | `pnpm record:claude <scenario>` | `src/claude/ClaudeAdapter.replay.test.ts` |

Each line of a fixture is one JSON record: a `transcript_start` header (CLI
version, scenario), then `expect_outbound` (what Docs sent), `emit_inbound`
(what the CLI answered) and a closing `runtime_exit`. This is the T3 Code
transcript format, so the Codex fixtures play through the vendored
`replay.ts`. Replay fails as soon as Docs sends anything the recording didn't.
Folders count too: the recorder writes them as placeholders (`/home/replay-user`,
`/tmp/replay-workspace`), and the Claude replay maps the test machine's folders
to the same placeholders before comparing.

Claude's permission requests are recorded too: Claude Code's `canUseTool`
question goes in as `emit_inbound {query, permission}`, and Docs' answer goes
out as `expect_outbound {query, permissionResult}`. The replay asks Docs' own
`canUseTool` at that point, so a different decision fails it. Codex approvals
need nothing extra: they are ordinary JSON-RPC requests and responses.

## Scenarios

Each scenario is written once, in `src/codex/replayScenarios.ts` and
`src/claude/replayScenarios.ts` (the turn, stop and approval steps are shared,
in `src/provider/replayScenario.ts`). The recorder runs it against the real CLI
and the replay test runs the same code against the recording, so the two
can't drift apart.

| Scenario   | Prompts | What it records                                                             |
| ---------- | ------- | --------------------------------------------------------------------------- |
| `library`  | none    | Handshake, catalog, document list, and opening a document. Committed.       |
| `turn`     | 2       | A new document, two short answers, then the document read back.             |
| `stop`     | 1       | A long answer (counting to 300), stopped as soon as its first words arrive. |
| `approval` | 2       | "Create tea.txt" (accepted), then "Now delete tea.txt" (denied).            |

- `library` needs no login, and any agent may re-record it.
  - Codex runs with an empty `CODEX_HOME`: signed out, with no documents, and
    a new document that Codex can't resume before its first turn. The recorder
    stops unless `account/read` answers `account: null`.
  - Claude runs with an empty home and config folder and no auth variables: no
    login (Docs shows the sign-in hint), an empty list, and a missing document.
    The recorder stops unless Claude Code reports `tokenSource: "none"`.
- `turn`, `stop` and `approval` send real prompts, so **only a person records
  them** (see below). Until a fixture exists, its replay test is skipped and
  says why.

## Recording the turn, stop and approval fixtures (owner only)

These recordings send short prompts to the real models, using your normal Codex
and Claude logins. Agents must never run them.

1. Sign in to both CLIs in a terminal (`codex login`; `claude`, then `/login`).
2. Record. `HIDEGPT_RECORD_NAMES` is optional: comma-separated names the
   recorder can't know (your full name, a company, a project), scrubbed and
   checked like your account name.
   ```bash
   export HIDEGPT_RECORD_TURNS=1
   export HIDEGPT_RECORD_NAMES="Your Full Name,Your Company"   # optional
   pnpm record:codex turn
   pnpm record:codex stop
   pnpm record:codex approval
   pnpm record:claude turn
   pnpm record:claude stop
   pnpm record:claude approval
   unset HIDEGPT_RECORD_TURNS HIDEGPT_RECORD_NAMES
   ```
   - Each run takes up to a few minutes and ends with `Wrote N ... to
     src/<provider>/fixtures/<scenario>.ndjson`.
   - The recorder answers approvals itself. The Codex `approval` run starts
     Codex with `-c approval_policy="on-request" -c sandbox_mode="read-only"`,
     so it asks before writing whatever your config says.
   - Claude Code asks before writing a file unless your settings already
     allow it. If the `approval` run fails with "ended without asking for
     approval", allow-listed `Write`/`Bash` in `~/.claude/settings.json` is the
     likely cause. Remove that rule for the recording, or skip this one.
3. Check the result:
   ```bash
   pnpm test src/codex/CodexAdapter.replay.test.ts src/claude/ClaudeAdapter.replay.test.ts src/provider/replayFixture.test.ts
   ```
   The matching tests now run instead of being skipped. The fixture test checks
   that no email, home or temp path, or token is left in any file. Names
   differ per machine, so the recorder checks those before it writes.
4. Read `git diff` before committing. The recorder scrubs emails, paths,
   usernames, the hostname, `HIDEGPT_RECORD_NAMES` and tokens. It also blanks
   Claude's list of your MCP servers, skills, plugins and agents, and Codex's
   MCP server names and startup errors and disabled plugin ids. The model's
   answers stay as recorded. A name that is also a word of a placeholder
   (`replay`, `user`, `host`, `example`, `home`, `tmp`, `workspace`, `codex`)
   is not scrubbed or checked, since it would match the placeholders
   themselves. If your account or git name is one of those, look for it
   yourself.
5. Each run leaves one document in that provider's history, so archive or
   delete it there if you like. The `tea.txt` it writes is in a temporary
   folder the recorder deletes.

Without `HIDEGPT_RECORD_TURNS=1` the recorders refuse to send a turn:

- They refuse every scenario with prompts up front.
- The Codex recorder only lets the no-prompt methods (`NO_PROMPT_METHODS` in
  `src/codex/replay.ts`) reach Codex.
- The Claude recorder never passes a prompt on to Claude Code.

## Re-recording after a CLI update

Do this whenever you update Codex or Claude Code. Run
`pnpm record:codex library` and `pnpm record:claude library`, then
`pnpm test`. A replay failure shows the first frame that differs.

- If the CLI changed, fix the adapter (and run `pnpm protocol` for Codex).
- If only the recording changed, commit the new fixture.

Re-record the `turn`, `stop` and `approval` fixtures the same way, by hand.
