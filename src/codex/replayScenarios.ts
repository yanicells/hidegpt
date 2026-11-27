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
  type ApprovalResult,
  type ReplayScenario,
  SETTINGS,
  STOP_PROMPT,
  stopScenario,
  TURN_PROMPTS,
  turnScenario,
} from '../provider/replayScenario'
import type { DocSummary } from '../shared/contracts'

/**
 * Codex's replay scenarios, shared by scripts/record-codex-replay.ts and
 * CodexAdapter.replay.test.ts. See docs/replay-fixtures.md.
 */

/** A Codex scenario may override `codex app-server` config (`-c key=value`) while recording. */
export type CodexScenario<A> = ReplayScenario<A> & { readonly config?: ReadonlyArray<string> }

export type LibraryResult = {
  readonly catalog: Catalog
  readonly docs: Option.Option<ReadonlyArray<DocSummary>>
  readonly created: OpenedThread
  readonly resumed: Exit.Exit<OpenedThread, ProviderError>
}

export const library: CodexScenario<LibraryResult> = {
  description:
    'Handshake, catalog and document list, signed out; then a new document, which Codex cannot resume before its first turn. No prompt.',
  prompts: [],
  run: ({ session, workspace, afterCatalog }) =>
    Effect.gen(function* () {
      const catalog = yield* session.loadCatalog
      yield* afterCatalog
      const docs = yield* Stream.runHead(session.listDocs(''))
      const created = yield* session.createThread({ cwd: workspace, projectId: null, title: null, settings: SETTINGS })
      // Codex keeps no transcript until the first turn, so this records its real "no rollout" error.
      const resumed = yield* Effect.exit(session.openThread(created.threadId))
      yield* session.releaseThread(created.threadId)
      return { catalog, docs, created, resumed }
    }),
}

export const turn = turnScenario(TURN_PROMPTS)
export const stop = stopScenario(STOP_PROMPT)
export const approval: CodexScenario<ApprovalResult> = {
  ...approvalScenario(APPROVAL_PROMPTS, APPROVAL_DECISIONS),
  // Whatever the person's own config says, ask before writing anything.
  config: ['approval_policy="on-request"', 'sandbox_mode="read-only"'],
}

export const SCENARIOS: Readonly<Record<string, CodexScenario<unknown>>> = { library, turn, stop, approval }
