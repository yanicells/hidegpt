import * as Schema from 'effect/Schema'

/**
 * The provider-neutral contracts, as `effect/Schema` values (the T3 Code
 * `packages/contracts` pattern). Main decodes every renderer `Command` with
 * these at the IPC boundary; the domain types below are derived from them.
 *
 * Import runtime values from this module only in main. The renderer imports
 * types (erased at build time) through `./model`, so Effect never lands in the
 * renderer bundle.
 */

export const ProviderId = Schema.Literals(['codex', 'opencode', 'claude'])
export type ProviderId = typeof ProviderId.Type

export const Route = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('home') }),
  Schema.Struct({ kind: Schema.Literal('doc'), threadId: Schema.String }),
])
export type Route = typeof Route.Type

/** One document on Home. Times are Unix seconds. */
export const DocSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  preview: Schema.String,
  updatedAt: Schema.Number,
  cwd: Schema.String,
  projectId: Schema.NullOr(Schema.String),
})
export type DocSummary = typeof DocSummary.Type

export const ProjectSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  roots: Schema.Array(Schema.Struct({ path: Schema.String })),
})
export type ProjectSummary = typeof ProjectSummary.Type

export const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** Reasoning efforts the model accepts, in menu order. Empty hides the effort menu. */
  efforts: Schema.Array(Schema.String),
  defaultEffort: Schema.NullOr(Schema.String),
  /** Speed tiers (Codex). Empty hides the speed menu. */
  serviceTiers: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  isDefault: Schema.Boolean,
})
export type ModelOption = typeof ModelOption.Type

/** A Codex collaboration mode or an OpenCode agent. */
export const ModeOption = Schema.Struct({ id: Schema.String, label: Schema.String })
export type ModeOption = typeof ModeOption.Type

/** Who the library belongs to. Only Codex signs in inside Docs. */
export const AccountSummary = Schema.Struct({
  kind: Schema.Literals(['chatgpt', 'apiKey', 'local', 'other']),
  label: Schema.String,
})
export type AccountSummary = typeof AccountSummary.Type

/** An MCP server; `needsConnect` ones are offered under "Connect …". */
export const ToolServer = Schema.Struct({ name: Schema.String, needsConnect: Schema.Boolean })
export type ToolServer = typeof ToolServer.Type

/** A skill the provider can load for one message. `path` is provider-private. */
export const Skill = Schema.Struct({ name: Schema.String, description: Schema.String, path: Schema.String })
export type Skill = typeof Skill.Type

/** `commentary` marks progress notes between tool calls (hidden in output-only view). */
export const AgentBlock = Schema.Struct({
  kind: Schema.Literal('agent'),
  id: Schema.String,
  text: Schema.String,
  commentary: Schema.optionalKey(Schema.Boolean),
})
export type AgentBlock = typeof AgentBlock.Type

/** `images` are local file paths or data/http URLs; `skills` are skill names sent with the message. */
export const UserBlock = Schema.Struct({
  kind: Schema.Literal('user'),
  id: Schema.String,
  text: Schema.String,
  images: Schema.optionalKey(Schema.Array(Schema.String)),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type UserBlock = typeof UserBlock.Type

export const CalloutBlock = Schema.Struct({
  kind: Schema.Literal('callout'),
  id: Schema.String,
  title: Schema.String,
  body: Schema.String,
})
export type CalloutBlock = typeof CalloutBlock.Type

export const ApprovalField = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  initial: Schema.optionalKey(Schema.String),
})
export type ApprovalField = typeof ApprovalField.Type

export const ApprovalQuestion = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.String),
  allowText: Schema.Boolean,
})
export type ApprovalQuestion = typeof ApprovalQuestion.Type

/**
 * A question the agent is waiting on. Display data only: the adapter keeps
 * the raw request (ids, params, resolver) and builds the reply itself.
 */
export const ApprovalBlock = Schema.Struct({
  kind: Schema.Literal('approval'),
  id: Schema.String,
  title: Schema.String,
  body: Schema.String,
  fields: Schema.Array(ApprovalField),
  questions: Schema.Array(ApprovalQuestion),
  resolved: Schema.NullOr(Schema.Literals(['accepted', 'skipped'])),
  /** A reply is on its way to the provider. */
  pending: Schema.optionalKey(Schema.Boolean),
})
export type ApprovalBlock = typeof ApprovalBlock.Type

export const Block = Schema.Union([AgentBlock, UserBlock, CalloutBlock, ApprovalBlock])
export type Block = typeof Block.Type

/** Answers keyed by ApprovalField/ApprovalQuestion id. */
export const ApprovalReply = Schema.Struct({
  accept: Schema.Boolean,
  answers: Schema.Record(Schema.String, Schema.String),
})
export type ApprovalReply = typeof ApprovalReply.Type

/** What a provider supports, so the UI never branches on provider names. */
export const Capabilities = Schema.Struct({
  /** "Log in with ChatGPT" / "Log out" in Docs. */
  login: Schema.Boolean,
  /** "Connect <app>" for MCP servers that need OAuth. */
  connectTools: Schema.Boolean,
  /** Projects are created from a folder inside Docs. */
  createProjects: Schema.Boolean,
  /** Projects must be Git folders (OpenCode). */
  gitProjects: Schema.Boolean,
})
export type Capabilities = typeof Capabilities.Type

export const ProviderStatus = Schema.Literals(['connecting', 'ready', 'error'])
export type ProviderStatus = typeof ProviderStatus.Type

/** Everything the window draws: the active library plus the open document. */
export const Snapshot = Schema.Struct({
  provider: ProviderId,
  capabilities: Capabilities,
  status: ProviderStatus,
  /** Banner text. Never replaces the page. */
  error: Schema.NullOr(Schema.String),
  account: Schema.NullOr(AccountSummary),
  requiresAuth: Schema.Boolean,
  loginUrl: Schema.NullOr(Schema.String),
  models: Schema.Array(ModelOption),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  /** Selected service-tier id (speed). Null means the thread default. */
  serviceTier: Schema.NullOr(Schema.String),
  collaborationModes: Schema.Array(ModeOption),
  collaborationMode: Schema.NullOr(Schema.String),
  projects: Schema.Array(ProjectSummary),
  threads: Schema.Array(DocSummary),
  /** Folder new documents start in. */
  cwd: Schema.String,
  search: Schema.String,
  mcpServers: Schema.Array(ToolServer),
  skills: Schema.Array(Skill),
  route: Route,
  title: Schema.String,
  blocks: Schema.Array(Block),
  streaming: Schema.Boolean,
  /** Stop was pressed; the turn has not ended yet. */
  stopping: Schema.Boolean,
  hasOlder: Schema.Boolean,
  loadingOlder: Schema.Boolean,
  openingThreadId: Schema.NullOr(Schema.String),
})
export type Snapshot = typeof Snapshot.Type

/**
 * A change to the last snapshot the window has. `fields` replaces top-level
 * values; `blocks.set` replaces whole blocks by index and `blocks.append`
 * appends streamed text to the agent text (or callout body) at an index, so a
 * streaming answer crosses IPC as its new characters only.
 */
export const SnapshotPatch = Schema.Struct({
  fields: Schema.Record(Schema.String, Schema.Unknown),
  blocks: Schema.optionalKey(
    Schema.Struct({
      length: Schema.Number,
      set: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.Number, Block]))),
      append: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.Number, Schema.String]))),
    }),
  ),
})
export type SnapshotPatch = typeof SnapshotPatch.Type

const op = <const Op extends string, const Fields extends Schema.Struct.Fields = {}>(
  name: Op,
  fields?: Fields,
) => Schema.Struct({ op: Schema.Literal(name), ...(fields ?? ({} as Fields)) })

/** Everything the renderer can ask main to do. Decoded in main before it runs. */
export const Command = Schema.Union([
  op('newDocument', {
    projectId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    cwd: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
  }),
  op('createProject', { name: Schema.String, cwd: Schema.String }),
  op('openThread', { threadId: Schema.String }),
  op('goHome'),
  op('send', {
    text: Schema.String,
    skill: Schema.optionalKey(Schema.String),
    images: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  op('interrupt'),
  op('login'),
  op('logout'),
  op('connectMcp', { name: Schema.String }),
  op('setSearch', { value: Schema.String }),
  op('applySearch'),
  op('setModel', { model: Schema.String }),
  op('setEffort', { effort: Schema.String }),
  op('setServiceTier', { serviceTier: Schema.NullOr(Schema.String) }),
  op('setCollaborationMode', { name: Schema.String }),
  op('openFolder'),
  op('loadOlderTurns'),
  op('resolveApproval', {
    blockId: Schema.String,
    accept: Schema.Boolean,
    answers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  op('setDocumentName', { name: Schema.String }),
  op('setProvider', { provider: ProviderId, home: Schema.optionalKey(Schema.Boolean) }),
  op('refresh'),
])
export type Command = typeof Command.Type

/** Every command settles with a result; failures carry a readable message. */
export const CommandResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])
export type CommandResult = typeof CommandResult.Type

export const MenuAction = Schema.Literals(['rename', 'grid', 'list', 'newDocument', 'goHome', 'focusSearch'])
export type MenuAction = typeof MenuAction.Type
