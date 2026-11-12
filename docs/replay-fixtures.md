# Replay fixtures

Replay tests run the real Codex and Claude adapters against conversations
recorded from the real CLIs. The fakes (`FakeCodex`, `FakeClaude`) are written
by hand; a recording is what the CLI actually sent. A replay pins two things:
what the adapter sends, and how it handles the CLI's real answers. It plays
back a fixed recording, so it can't notice a CLI update by itself. Re-record
after updating a CLI (see the end of this page).

The recorders run the app's TypeScript directly with Node, so they need
Node 22.18 or later (`engines` in package.json), as does the app.

| Provider | Fixture | Recorder | Test |
|---|---|---|---|
| Codex | `src/codex/fixtures/<scenario>.ndjson` (JSON-RPC frames) | `pnpm record:codex <scenario>` | `src/codex/CodexAdapter.replay.test.ts` |
| Claude | `src/claude/fixtures/<scenario>.ndjson` (Agent SDK calls, answers and messages) | `pnpm record:claude <scenario>` | `src/claude/ClaudeAdapter.replay.test.ts` |

Each line of a fixture is one JSON record: a `transcript_start` header (CLI
version, scenario), then `expect_outbound` (what Docs sent), `emit_inbound`
(what the CLI answered) and a closing `runtime_exit`. This is the T3 Code
transcript format, so the Codex fixtures play through the vendored
`replay.ts`. Replay fails as soon as Docs sends anything the recording didn't.

## Scenarios

- **`library`** (committed, no prompt): handshake, catalog, document list,
  and opening a document.
  - Codex runs with an empty `CODEX_HOME`: signed out, with no documents, and
    a new document that Codex can't resume before its first turn.
  - Claude runs with an empty home and config folder and no auth variables: no
    login (Docs shows the sign-in hint), an empty list, and a missing document.
  - Neither run reads a login or your own documents, so agents may re-record it.
- **`turn`** (not committed yet): a new document, two short fixed prompts,
  then the document opened again to read its history. **A person has to record
  it** (see below). Until the file exists, the matching test is skipped and
  says why.

## Recording the turn fixtures (owner only)

These recordings send two short prompts to the real models, using your normal
Codex and Claude logins. Agents must never run them.

1. Sign in to both CLIs in a terminal (`codex login`; `claude`, then `/login`).
2. Record:
   ```bash
   HIDEGPT_RECORD_TURNS=1 pnpm record:codex turn
   HIDEGPT_RECORD_TURNS=1 pnpm record:claude turn
   ```
3. Check the result:
   ```bash
   pnpm test src/codex/CodexAdapter.replay.test.ts src/claude/ClaudeAdapter.replay.test.ts src/provider/replayFixture.test.ts
   ```
   The `turn` tests now run instead of being skipped. The fixture test checks
   that no email, home path, username or token is left in either file.
4. Read `git diff` before committing. The recorder scrubs emails, paths,
   usernames, the hostname and tokens. It also blanks Claude's list of your MCP
   servers, skills, plugins and agents. The model's answers stay as recorded.
5. Each run leaves one "tea" document in that provider's history, so archive
   or delete it there if you like.

Without `HIDEGPT_RECORD_TURNS=1` the recorders refuse to send a turn:

- They refuse the `turn` scenario up front.
- The Codex recorder only lets the no-prompt methods (`NO_PROMPT_METHODS` in
  `src/codex/replay.ts`) reach Codex.
- The Claude recorder never passes a prompt on to Claude Code.

## Re-recording after a CLI update

Do this whenever you update Codex or Claude Code. Run
`pnpm record:codex library` and `pnpm record:claude library`, then
`pnpm test`. A replay failure shows the first frame that differs.

- If the CLI changed, fix the adapter (and run `pnpm protocol` for Codex).
- If only the recording changed, commit the new fixture.

Re-record the `turn` fixtures the same way, by hand.
