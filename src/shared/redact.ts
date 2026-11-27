// Adapted from T3 Code (packages/shared/src/observability.ts, redactCauseCredentials) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.

/**
 * The one set of personal-data and secret patterns, shared by main's log
 * (`src/main/logging/redact.ts`) and the replay recorders
 * (`src/provider/replayFixture.ts`). Every pattern is global: use it with
 * `replace` or `matchAll`, never `test` or `exec`, which keep `lastIndex`.
 */

export const REDACTED = '<redacted>'

/** `text` with every RegExp metacharacter escaped. */
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `name` as a whole word: not inside a longer run of letters or digits (`al` never matches in `alice`). */
export const wholeWord = (name: string, flags: string) =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, flags)

/**
 * An email address, in any script (`jösé@exämple.com`, `राम@उदाहरण.भारत`).
 * Combining marks (`\p{M}`) count as address characters: Indic and Thai
 * scripts need them, and so does decomposed (NFD) Latin text, which macOS
 * often returns. It starts only where a run of address characters starts: the
 * leftmost match never starts later, and without it a long run with no `@` is
 * retried from every character (seconds for 10 KB of text).
 */
export const EMAIL =
  /(?<![\p{L}\p{M}\p{N}._%+-])[\p{L}\p{M}\p{N}._%+-]+@[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)*\.\p{L}[\p{L}\p{M}]+/gu

/** Well-known token formats: JWTs, provider API keys (`sk-…`, `sk-ant-…`) and GitHub tokens. */
export const TOKEN =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}/g

/**
 * Credential shapes that can turn up in an error message or a stack, with
 * their replacements. Like T3 Code's pattern, each is narrow, so ordinary text
 * such as `code=ENOENT` or "Basic setup" survives:
 * - in a URL query (`?` or `&` before the key), OAuth's `code` and `state` and
 *   signed-URL keys too;
 * - anywhere, only keys that always mean a secret;
 * - JSON fields of the same names;
 * - an Authorization header's value, and a long Bearer token;
 * - user:password in a URL.
 * `TOKEN` covers the well-known token formats.
 */
export const CREDENTIALS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /([?&])((?:access_|refresh_|id_)?token|api_?key|client_secret|secret|password|auth|code|state|ticket|signature|sig|wsTicket|dpop)=[^&#"'\s]*/gi,
    `$1$2=${REDACTED}`,
  ],
  [
    /(^|["'\s,;{])((?:access_|refresh_|id_)?token|api_?key|client_secret|secret|password|passwd)=[^&#"'\s]*/gi,
    `$1$2=${REDACTED}`,
  ],
  [
    /("(?:(?:access_|refresh_|id_)?token|api_?key|apiKey|client_secret|secret|password|authorization)"\s*:\s*)"[^"]*"/gi,
    `$1"${REDACTED}"`,
  ],
  [/(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${REDACTED}`],
  [/(:\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${REDACTED}@`],
]
