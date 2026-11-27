// Adapted from T3 Code (packages/shared/src/observability.ts, redactCauseCredentials, and its
// use in apps/server/src/serverLogger.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Cause from 'effect/Cause'
import * as Logger from 'effect/Logger'

/** Who the log must not name: the home folder and the account name. */
export interface Identity {
  readonly home: string
  readonly username: string
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Credential shapes that can turn up in an error message or a stack. Like T3
 * Code's pattern, each is narrow, so ordinary text such as `code=ENOENT` or
 * "Basic setup" survives:
 * - in a URL query (`?` or `&` before the key), OAuth's `code` and `state` and
 *   signed-URL keys too;
 * - anywhere, only keys that always mean a secret;
 * - JSON fields of the same names;
 * - an Authorization header's value, and a long Bearer token;
 * - user:password in a URL, and well-known token formats.
 */
const CREDENTIALS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /([?&])((?:access_|refresh_|id_)?token|api_?key|client_secret|secret|password|auth|code|state|ticket|signature|sig|wsTicket|dpop)=[^&#"'\s]*/gi,
    '$1$2=<redacted>',
  ],
  [
    /(^|["'\s,;{])((?:access_|refresh_|id_)?token|api_?key|client_secret|secret|password|passwd)=[^&#"'\s]*/gi,
    '$1$2=<redacted>',
  ],
  [
    /("(?:(?:access_|refresh_|id_)?token|api_?key|apiKey|client_secret|secret|password|authorization)"\s*:\s*)"[^"]*"/gi,
    '$1"<redacted>"',
  ],
  [/(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 <redacted>'],
  [/(:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1<redacted>@'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<redacted>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<redacted>'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted>'],
]

/**
 * Account names that are also common folder or file names. The home folder is
 * removed anyway, so replacing such a name elsewhere would only mangle paths
 * (`out/main/index.js`, `src/admin/x.ts`).
 */
const PATH_WORDS = new Set([
  'main',
  'admin',
  'user',
  'dev',
  'test',
  'root',
  'docs',
  'app',
  'home',
  'src',
  'lib',
  'bin',
  'out',
  'build',
  'node',
])

/** Removes the home folder (as `~`), the account name, and credential-looking strings from `text`. */
export function makeRedactor({ home, username }: Identity): (text: string) => string {
  // Only the whole folder: `/Users/alice` must not match inside `/Users/alicebob`.
  const homePath = home.length > 1 ? new RegExp(`${escape(home)}(?=[/\\\\"'\\s:)]|$)`, 'g') : null
  // A very short name, or one that is also a common path word, would match ordinary text.
  const name =
    username.length >= 3 && !PATH_WORDS.has(username.toLowerCase())
      ? new RegExp(`(?<![A-Za-z0-9])${escape(username)}(?![A-Za-z0-9])`, 'g')
      : null
  return (text) => {
    let out = homePath ? text.replace(homePath, '~') : text
    if (name) out = out.replace(name, '<user>')
    for (const [pattern, replacement] of CREDENTIALS) out = out.replace(pattern, replacement)
    return out
  }
}

/**
 * The cause as `redact` leaves it. Like T3 Code's `redactCauseCredentials`, it
 * renders the cause (message and stack), and when anything was removed, logs
 * that text instead of the original.
 */
export function redactCause(cause: Cause.Cause<unknown>, redact: (text: string) => string): Cause.Cause<unknown> {
  if (cause.reasons.length === 0 || Cause.hasInterruptsOnly(cause)) return cause
  const pretty = Cause.pretty(cause)
  const redacted = redact(pretty)
  if (redacted === pretty) return cause
  // An error that renders as exactly that text: its first line as name and message, and the
  // whole text as its stack (which already holds the original stacks).
  const head = /^([A-Za-z]*Error): (.*)$/.exec(redacted.split('\n', 1)[0] ?? '')
  const error = new Error(head ? head[2] : redacted.split('\n', 1)[0])
  if (head) error.name = head[1]!
  error.stack = redacted
  return Cause.die(error)
}

/** `logger`, writing causes only after `redact`. */
export const redacting = <Output>(logger: Logger.Logger<unknown, Output>, redact: (text: string) => string) =>
  Logger.make<unknown, Output>((options) => logger.log({ ...options, cause: redactCause(options.cause, redact) }))
