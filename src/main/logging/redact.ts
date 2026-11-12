// Adapted from T3 Code (packages/shared/src/observability.ts, redactCauseCredentials, and its
// use in apps/server/src/serverLogger.ts) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import * as Cause from 'effect/Cause'
import * as Logger from 'effect/Logger'

import { CREDENTIALS, EMAIL, escapeRegExp, REDACTED, TOKEN, wholeWord } from '../../shared/redact'

/** Who the log must not name: the home folder and the account name. */
export interface Identity {
  readonly home: string
  readonly username: string
}

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

/**
 * Removes the home folder (as `~`), emails, credential-looking strings and the
 * account name from `text`.
 */
export function makeRedactor({ home, username }: Identity): (text: string) => string {
  // Only the whole folder: `/Users/alice` must not match inside `/Users/alicebob`.
  const homePath = home.length > 1 ? new RegExp(`${escapeRegExp(home)}(?=[/\\\\"'\\s:)]|$)`, 'g') : null
  // A very short name, or one that is also a common path word, would match ordinary text.
  const name = username.length >= 3 && !PATH_WORDS.has(username.toLowerCase()) ? wholeWord(username, 'g') : null
  return (text) => {
    let out = homePath ? text.replace(homePath, '~') : text
    for (const [pattern, replacement] of CREDENTIALS) out = out.replace(pattern, replacement)
    out = out.replace(TOKEN, REDACTED).replace(EMAIL, '<email>')
    // Last, so an address made of the name (`alice@example.com`) goes as a whole.
    if (name) out = out.replace(name, '<user>')
    return out
  }
}

/** The most of a cause's text the log keeps. A defect's message can quote a whole request or response. */
export const MAX_CAUSE_BYTES = 2048
const CUT = '\n… (cut)'

/** `text`, cut to at most `MAX_CAUSE_BYTES` of UTF-8, marked when cut. */
export function capCause(text: string): string {
  if (Buffer.byteLength(text) <= MAX_CAUSE_BYTES) return text
  const head = Buffer.from(text)
    .subarray(0, MAX_CAUSE_BYTES - Buffer.byteLength(CUT))
    .toString('utf8')
    // A character cut in half decodes as U+FFFD.
    .replace(/\uFFFD$/, '')
  return head + CUT
}

/**
 * The cause as `redact` and `capCause` leave it. Like T3 Code's
 * `redactCauseCredentials`, it renders the cause (message and stack), and when
 * anything was removed or cut, logs that text instead of the original.
 */
export function redactCause(cause: Cause.Cause<unknown>, redact: (text: string) => string): Cause.Cause<unknown> {
  if (cause.reasons.length === 0 || Cause.hasInterruptsOnly(cause)) return cause
  const pretty = Cause.pretty(cause)
  const redacted = capCause(redact(pretty))
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
