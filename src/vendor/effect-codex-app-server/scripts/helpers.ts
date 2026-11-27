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

/**
 * HideGPT: the entries the allowlist names, in the CLI's order. Throws when the allowlist names
 * a method this CLI does not publish, so an upgrade that renames one fails `pnpm protocol`.
 */
export function selectAllowed(
  kind: string,
  entries: ReadonlyArray<MethodEntry>,
  allowed: ReadonlyArray<string>,
): ReadonlyArray<MethodEntry> {
  const published = new Set(entries.map((entry) => entry.method));
  const missing = allowed.filter((method) => !published.has(method));
  if (missing.length > 0) {
    throw new Error(`Allowlisted ${kind} this codex-cli does not publish: ${missing.join(", ")}`);
  }
  const keep = new Set(allowed);
  return entries.filter((entry) => keep.has(entry.method));
}

const SCHEMA_REF = "#/components/schemas/";

/** HideGPT: `roots` and every schema they reach through `#/components/schemas/` refs. */
export function reachableSchemas(
  roots: Iterable<string>,
  schemas: Readonly<Record<string, unknown>>,
): Set<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref" && typeof child === "string" && child.startsWith(SCHEMA_REF)) {
          pending.push(child.slice(SCHEMA_REF.length));
        } else {
          visit(child);
        }
      }
    }
  };
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue;
    if (!Object.hasOwn(schemas, name)) throw new Error(`Unable to resolve schema: ${name}`);
    reached.add(name);
    visit(schemas[name]);
  }
  return reached;
}

/**
 * HideGPT: a JSON schema without its `description`s. They only become runtime annotations
 * nothing reads (the generated types carry no comments) and are a fifth of the emitted code.
 * Visits schema positions only, so a property named `description` stays.
 */
export function withoutDescriptions(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutDescriptions);
  if (schema === null || typeof schema !== "object") return schema;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema)) {
    if (key === "description") continue;
    result[key] =
      (key === "properties" || key === "definitions") && child !== null && typeof child === "object"
        ? Object.fromEntries(
            Object.entries(child).map(([name, value]) => [name, withoutDescriptions(value)]),
          )
        : SCHEMA_KEYS.has(key)
          ? withoutDescriptions(child)
          : child;
  }
  return result;
}

// The positions the CLI's schemas nest schemas in, besides `properties` and `definitions`.
const SCHEMA_KEYS = new Set(["items", "additionalProperties", "anyOf", "oneOf", "allOf"]);
