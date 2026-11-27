// Vendored from T3 Code (https://github.com/pingdotgg/t3code), packages/effect-codex-app-server
// scripts/generate.ts at commit 8a14762c. Copyright (c) 2026 T3 Tools Inc. MIT License; see
// THIRD_PARTY_NOTICES.md. HideGPT changes are marked "HideGPT:".
//
// HideGPT: the generator's pure method and version helpers, moved out of generate.ts (which
// runs on import) so tests can cover them with fixtures.

/** HideGPT: the response type for a method the CLI publishes no response schema for. */
export const UNRESOLVED_RESPONSE = "UnresolvedResponse";

export interface MethodEntry {
  readonly method: string;
  readonly paramsType?: string;
}

export function toPascalCaseMethod(method: string) {
  return method
    .split("/")
    .flatMap((segment) => segment.split(/(?=[A-Z])/))
    .flatMap((segment) => segment.split(/[-_]/))
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
}

export function parseRequestEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)",\s*id:\s*RequestId,\s*params(\??):\s*([^,}|]+)/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      paramsType: `${match[2] ? "Nullable" : ""}${match[3]!.trim()}`,
    });
  }
  return entries;
}

export function parseNotificationEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)"(?:,\s*"params":\s*([^ }]+))?\s*\}/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      ...(match[2] ? { paramsType: match[2].trim() } : {}),
    });
  }
  return entries;
}

export function resolveSchemaTypeName(
  rawTypeName: string,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  if (rawTypeName === "undefined") {
    return "undefined";
  }

  const candidates = [
    rawTypeName,
    `V2${rawTypeName}`,
    `V1${rawTypeName}`,
    `SerdeJson${rawTypeName}`,
    // HideGPT: Codex 0.166 publishes optional params as `Nullable<Name>` JSON schemas.
    `Nullable${rawTypeName}`,
    `V2Nullable${rawTypeName}`,
  ];
  for (const candidate of candidates) {
    if (generatedSchemaNames.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve schema type name: ${rawTypeName}`);
}

export function resolveResponseTypeName(
  method: string,
  paramsType: string | undefined,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  const overrides: Record<string, string> = {
    "accountSession/list": "AccountSessionsResponse",
    "account/gatewayOAuth/cancel": "GatewayOAuthCancelResponse",
    "account/gatewayOAuth/login": "GatewayOAuthLoginResponse",
    "account/gatewayOAuth/read": "GatewayOAuthReadResponse",
    "account/logout": "LogoutAccountResponse",
    "account/rateLimits/read": "GetAccountRateLimitsResponse",
    // HideGPT: added in codex-cli 0.172.0.
    "account/securitySetup/read": "GetAccountSecuritySetupResponse",
    "account/usage/read": "GetAccountTokenUsageResponse",
    "account/workspaceMessages/read": "GetWorkspaceMessagesResponse",
    "config/batchWrite": "ConfigWriteResponse",
    "config/mcpServer/reload": "McpServerRefreshResponse",
    "config/value/write": "ConfigWriteResponse",
    "configRequirements/read": "ConfigRequirementsReadResponse",
    "externalAgentConfig/import/readHistories": "ExternalAgentConfigImportHistoriesReadResponse",
  };

  const override = overrides[method];
  if (override) {
    return resolveSchemaTypeName(override, generatedSchemaNames);
  }

  if (paramsType && paramsType !== "undefined") {
    const fromParams = paramsType.replace(/Params$/, "Response");
    try {
      return resolveSchemaTypeName(fromParams, generatedSchemaNames);
    } catch {}
  }

  // HideGPT: a newer CLI can publish a method's params with no response schema (0.172.0's
  // `modelProvider/default/set`). Fall back to a JSON response instead of throwing, so
  // `pnpm protocol` still runs.
  try {
    return resolveSchemaTypeName(`${toPascalCaseMethod(method)}Response`, generatedSchemaNames);
  } catch {
    return UNRESOLVED_RESPONSE;
  }
}

/** HideGPT: the schema entry for `UNRESOLVED_RESPONSE`, emitted only when a method needs it. */
export const UNRESOLVED_RESPONSE_ENTRY = [
  `export type ${UNRESOLVED_RESPONSE} = Schema.Json`,
  `export const ${UNRESOLVED_RESPONSE} = Schema.Json.annotate({ "identifier": "${UNRESOLVED_RESPONSE}" })`,
].join("\n");

/** HideGPT: the CLI version a generated file names in its `// Generated from:` line. */
export function generatedFromVersion(source: string): string | null {
  return /^\/\/ Generated from: (.+)$/m.exec(source)?.[1]?.trim() ?? null;
}

/**
 * HideGPT: why `--check` must stop before regenerating, or null when the committed schemas
 * were generated from the installed CLI. Comparing versions first keeps a newer CLI's schema
 * changes from crashing the generator mid-check.
 */
export function versionMismatch(committed: string | null, installed: string): string | null {
  if (committed === installed) return null;
  return `Codex protocol schemas are for ${committed ?? "an unknown codex-cli"}, installed ${installed}. Run \`pnpm protocol\`.`;
}
