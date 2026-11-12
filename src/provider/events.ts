// Shapes adapted from T3 Code (https://github.com/pingdotgg/t3code) at commit 5c6f2f12:
// packages/provider-core/src/server/ProviderAdapter.ts (the `turn.terminal` event) and
// packages/contracts/src/orchestrationV2.ts (provider failure classes, typed turn items).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Schema from 'effect/Schema'

import { ApprovalField, ApprovalQuestion } from '../shared/contracts'

/**
 * The canonical contract between adapters and the session manager. Adapters
 * report data, never sentences: a tool item says it is a `command` and names
 * the command; `src/main/session/present.ts` alone decides the Docs wording.
 * Every turn has an app-owned id (allocated by the manager before it sends)
 * and exactly one terminal with a status and a typed failure.
 *
 * These are Schemas so the event log can encode and later decode them (ARCH-8).
 * Main only; the renderer still receives presented `Block`s.
 */

/** App-owned turn id. Provider-native turn ids are correlation data inside the tracker, never this. */
export const TurnId = Schema.String
export type TurnId = typeof TurnId.Type

export const FailureClass = Schema.Literals([
  'usage_limit',
  'auth',
  'provider_error',
  'transport_error',
  'validation_error',
  'unknown',
])
export type FailureClass = typeof FailureClass.Type

/** Why a turn failed. `class` picks the sentence the page shows; `detail` never reaches the page. */
export const Failure = Schema.Struct({
  class: FailureClass,
  /** Provider text, redacted and bounded. Logs only. */
  detail: Schema.String,
  retryable: Schema.NullOr(Schema.Boolean),
  /** Epoch ms. Only for `usage_limit`, when the provider says when the limit resets. */
  resetAt: Schema.NullOr(Schema.Number),
  /** Names the log line that holds `detail`; the page shows it. Set by the session manager. */
  reportId: Schema.optionalKey(Schema.String),
})
export type Failure = typeof Failure.Type

export const ToolKind = Schema.Literals([
  'command',
  'file_read',
  'file_change',
  'file_search',
  'web_search',
  'web_fetch',
  'mcp_tool',
  'subagent',
  'compaction',
  'review',
  'other',
])
export type ToolKind = typeof ToolKind.Type

export const ToolStatus = Schema.Literals(['running', 'completed', 'failed'])
export type ToolStatus = typeof ToolStatus.Type

export const RequestKind = Schema.Literals([
  'command',
  'file_change',
  'permissions',
  'tool_access',
  'user_input',
  'form',
])
export type RequestKind = typeof RequestKind.Type

/** `sending`: the person answered and the reply is on its way. The last three are final. */
export const RequestStatus = Schema.Literals(['pending', 'sending', 'accepted', 'declined', 'expired'])
export type RequestStatus = typeof RequestStatus.Type

export const NoticeKind = Schema.Literals(['retrying', 'compacted', 'warning'])
export type NoticeKind = typeof NoticeKind.Type

/**
 * Wording an adapter still writes itself, until it moves onto typed items
 * (ARCH-4). `present.ts` shows it as written unless it fails the stealth gate.
 * ARCH-7 deletes this field.
 */
const Legacy = Schema.optionalKey(Schema.Struct({ title: Schema.String }))

export const UserItem = Schema.Struct({
  kind: Schema.Literal('user'),
  id: Schema.String,
  text: Schema.String,
  images: Schema.optionalKey(Schema.Array(Schema.String)),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type UserItem = typeof UserItem.Type

/** `commentary`: a progress note between tool calls (hidden in the output-only view). */
export const AssistantItem = Schema.Struct({
  kind: Schema.Literal('assistant'),
  id: Schema.String,
  text: Schema.String,
  phase: Schema.Literals(['commentary', 'final']),
})
export type AssistantItem = typeof AssistantItem.Type

export const ToolItem = Schema.Struct({
  kind: Schema.Literal('tool'),
  id: Schema.String,
  tool: ToolKind,
  status: ToolStatus,
  /** The thing itself: the command, the path, the query, the server name. Data, not a sentence. */
  subject: Schema.NullOr(Schema.String),
  /** What it printed; streamed output grows this. */
  output: Schema.String,
  legacy: Legacy,
})
export type ToolItem = typeof ToolItem.Type

/** Something the provider waits on the person for. The adapter keeps the raw request and builds the reply. */
export const RequestItem = Schema.Struct({
  kind: Schema.Literal('request'),
  id: Schema.String,
  request: RequestKind,
  status: RequestStatus,
  subject: Schema.NullOr(Schema.String),
  /** The provider's reason or message, as data. */
  detail: Schema.String,
  fields: Schema.Array(ApprovalField),
  questions: Schema.Array(ApprovalQuestion),
  legacy: Legacy,
})
export type RequestItem = typeof RequestItem.Type

export const NoticeItem = Schema.Struct({
  kind: Schema.Literal('notice'),
  id: Schema.String,
  notice: NoticeKind,
  detail: Schema.NullOr(Schema.String),
})
export type NoticeItem = typeof NoticeItem.Type

export const Item = Schema.Union([UserItem, AssistantItem, ToolItem, RequestItem, NoticeItem])
export type Item = typeof Item.Type

export const TurnStatus = Schema.Literals(['completed', 'interrupted', 'failed'])
export type TurnStatus = typeof TurnStatus.Type

export const ThreadEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal('turn.started'), threadId: Schema.String, turnId: TurnId }),
  /** The turn's one terminal. `failure` is set exactly when `status` is `failed`. */
  Schema.Struct({
    type: Schema.Literal('turn.ended'),
    threadId: Schema.String,
    turnId: TurnId,
    status: TurnStatus,
    failure: Schema.NullOr(Failure),
  }),
  /** Insert or replace by id; `replaces` names the optimistic echo a server user message confirms. */
  Schema.Struct({
    type: Schema.Literal('item.upserted'),
    threadId: Schema.String,
    turnId: Schema.NullOr(TurnId),
    item: Item,
    replaces: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  /**
   * Streamed text for an assistant item's `text` or a tool item's `output`.
   * `create` is the item to start from when the delta names an item not seen
   * yet (a provider may stream before it announces the item).
   */
  Schema.Struct({
    type: Schema.Literal('item.delta'),
    threadId: Schema.String,
    itemId: Schema.String,
    delta: Schema.String,
    create: Schema.optionalKey(Schema.Union([AssistantItem, ToolItem])),
  }),
  /** Replace the thread's items (after a reconnect). Open requests are kept. */
  Schema.Struct({
    type: Schema.Literal('thread.reset'),
    threadId: Schema.String,
    items: Schema.Array(Item),
    activeTurnId: Schema.NullOr(TurnId),
  }),
  Schema.Struct({ type: Schema.Literal('thread.renamed'), threadId: Schema.String, title: Schema.String }),
  /** The thread is gone (deleted, archived) and cannot be used. */
  Schema.Struct({ type: Schema.Literal('thread.closed'), threadId: Schema.String }),
])
export type ThreadEvent = typeof ThreadEvent.Type

/** True for the request statuses that end the request. */
export const isFinalRequestStatus = (status: RequestStatus): boolean =>
  status === 'accepted' || status === 'declined' || status === 'expired'
