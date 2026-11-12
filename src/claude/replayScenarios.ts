import * as Effect from 'effect/Effect'
import type * as Exit from 'effect/Exit'
import type * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import type { ProviderError } from '../provider/errors'
import type { Catalog, OpenedThread } from '../provider/ProviderAdapter'
import {
  APPROVAL_DECISIONS,
  APPROVAL_PROMPTS,
  approvalScenario,
  type ReplayScenario,
  STOP_PROMPT,
  stopScenario,
  TURN_PROMPTS,
  turnScenario,
} from '../provider/replayScenario'
import type { DocSummary } from '../shared/contracts'

/**
 * Claude's replay scenarios, shared by scripts/record-claude-replay.ts and
 * ClaudeAdapter.replay.test.ts. See docs/replay-fixtures.md.
 */

/** No such session exists; opening it records Claude's "not found" path. */
export const MISSING_SESSION = '00000000-0000-4000-8000-000000000001'

export type LibraryResult = {
  readonly catalog: Exit.Exit<Catalog, ProviderError>
  readonly docs: Option.Option<ReadonlyArray<DocSummary>>
  readonly missing: Exit.Exit<OpenedThread, ProviderError>
}

export const library: ReplayScenario<LibraryResult> = {
  description: 'Catalog probe with no login (Docs shows the sign-in hint), an empty document list, and a document that does not exist. No prompt.',
  prompts: [],
  run: ({ session, afterCatalog }) =>
    Effect.gen(function* () {
      const catalog = yield* Effect.exit(session.loadCatalog)
      yield* afterCatalog
      const docs = yield* Stream.runHead(session.listDocs(''))
      const missing = yield* Effect.exit(session.openThread(MISSING_SESSION))
      return { catalog, docs, missing }
    }),
}

export const turn = turnScenario(TURN_PROMPTS)
export const stop = stopScenario(STOP_PROMPT)
/** Claude Code asks before writing a file unless the person's settings already allow it. */
export const approval = approvalScenario(APPROVAL_PROMPTS, APPROVAL_DECISIONS)

export const SCENARIOS: Readonly<Record<string, ReplayScenario<unknown>>> = { library, turn, stop, approval }
