// HideGPT: the part of the Codex app-server protocol Docs uses. `pnpm protocol` emits only
// these methods and the schemas they reach, instead of every schema the CLI publishes (3.4 MB
// of source, 1.6 MB of the main bundle). A notification left off arrives as an unknown one:
// the client hands it to `handleUnknownServerNotification`, which the adapter does not set,
// so it is dropped. allowlist.test.ts fails when src/codex names a method that is not here.
//
// To use a new method: add it below, run `pnpm protocol`, then use it.

export const PROTOCOL_ALLOWLIST = {
  /** Sent by CodexAdapter (`rpc`). */
  clientRequests: [
    "account/login/start",
    "account/logout",
    "account/read",
    "collaborationMode/list",
    "initialize",
    "mcpServer/oauth/login",
    "mcpServerStatus/list",
    "model/list",
    "project/create",
    "project/list",
    "skills/list",
    "thread/list",
    "thread/name/set",
    "thread/resume",
    "thread/start",
    "thread/turns/list",
    "thread/unsubscribe",
    "turn/interrupt",
    "turn/start",
  ],
  clientNotifications: ["initialized"],
  /** Answered by CodexAdapter (`handle`, APPROVAL_METHODS). Codex waits on every one. */
  serverRequests: [
    "account/chatgptAuthTokens/refresh",
    "applyPatchApproval",
    "attestation/generate",
    "execCommandApproval",
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/call",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
  ],
  /** Handled by CodexAdapter (`on`, `onThread`), read raw by protocol.ts, or redacted by src/codex/replay.ts. */
  serverNotifications: [
    "account/login/completed",
    "account/rateLimits/updated",
    "account/updated",
    "configWarning",
    "error",
    "guardianWarning",
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
    "item/completed",
    "item/started",
    "mcpServer/oauthLogin/completed",
    "mcpServer/startupStatus/updated",
    "project/changed",
    "serverRequest/resolved",
    "skills/changed",
    "thread/archived",
    "thread/closed",
    "thread/deleted",
    "thread/name/updated",
    "thread/started",
    "thread/unarchived",
    "turn/completed",
    "turn/diff/updated",
    "turn/started",
    "warning",
  ],
} as const;

/**
 * Schemas code imports by name that no allowlisted method reaches (they live in the CLI's
 * `ClientRequest` union file): client.ts widens `turn/start` params with the collaboration
 * mode, and mapping.ts reads reasoning efforts.
 */
export const EXTRA_SCHEMAS = ["ClientRequest__CollaborationMode", "ClientRequest__ReasoningEffort"] as const;
