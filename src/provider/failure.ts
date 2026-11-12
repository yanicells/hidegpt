// Redaction and bounding adapted from T3 Code (https://github.com/pingdotgg/t3code),
// packages/provider-core/src/server/failure.ts at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { Failure, FailureClass } from './events'

/**
 * Native provider errors as a typed `Failure`. The class decides what the page
 * says (`presentFailure`); the provider's own text goes into `detail`, which
 * only the log sees, so it is redacted and bounded here, once.
 *
 * The table is deliberately small. Each adapter extends it with the codes its
 * provider really sends (ARCH-4).
 */

export type NativeError = {
  readonly message: string
  /** A machine-readable code the provider sent, such as `usage_limit_exceeded`. */
  readonly code?: string | null
  readonly httpStatus?: number | null
  /** Epoch ms; kept only for `usage_limit`. */
  readonly resetAt?: number | null
}

const MAX_DETAIL_LENGTH = 4_096

type Rule = {
  readonly class: FailureClass
  readonly retryable: boolean | null
  readonly status?: (status: number) => boolean
  /** Matched against the code, then the message. */
  readonly pattern?: RegExp
}

/** First match wins, so the specific classes come before the broad ones. */
const RULES: ReadonlyArray<Rule> = [
  // T3 treats Codex's HTTP 429 as a usage limit (CodexAdapterV2.ts, `codexErrorHttpStatus(...) === 429`).
  {
    class: 'usage_limit',
    retryable: false,
    status: (status) => status === 429,
    pattern: /usage[ _-]?limit|rate[ _-]?limit|quota|too many requests/i,
  },
  {
    class: 'auth',
    retryable: false,
    status: (status) => status === 401 || status === 403,
    pattern:
      /unauthori[sz]ed|unauthenticated|forbidden|not[ _-]?logged[ _-]?in|\bsign[ _-]?in\b|\blog[ _-]?in again|invalid[ _-]?api[ _-]?key/i,
  },
  {
    class: 'transport_error',
    retryable: true,
    pattern:
      /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network|connection (?:closed|lost|reset)|stream (?:closed|ended)/i,
  },
  {
    class: 'validation_error',
    retryable: false,
    status: (status) => status === 400 || status === 404 || status === 409 || status === 413 || status === 422,
    pattern: /invalid[ _-]?request|bad[ _-]?request|validation/i,
  },
  {
    class: 'provider_error',
    retryable: true,
    status: (status) => status >= 500,
    pattern: /overloaded|server[ _-]?error|internal[ _-]?error|unavailable/i,
  },
]

function matches(rule: Rule, error: NativeError): boolean {
  if (error.httpStatus != null && rule.status?.(error.httpStatus)) return true
  if (!rule.pattern) return false
  return (error.code ? rule.pattern.test(error.code) : false) || rule.pattern.test(error.message)
}

/** The failure for a native error. Anything the table does not recognize is `unknown`. */
export function classify(error: NativeError): Failure {
  const rule = RULES.find((candidate) => matches(candidate, error))
  const failureClass = rule?.class ?? 'unknown'
  const resetAt = error.resetAt
  return {
    class: failureClass,
    detail: boundedText(error.message, MAX_DETAIL_LENGTH),
    retryable: rule?.retryable ?? null,
    resetAt: failureClass === 'usage_limit' && typeof resetAt === 'number' && Number.isFinite(resetAt) ? resetAt : null,
  }
}

/**
 * A failure an adapter classed from its provider's own fields (status codes, error
 * kinds), with the provider text redacted and bounded the same way.
 */
export function failureOf(failureClass: FailureClass, message: string): Failure {
  return {
    class: failureClass,
    detail: boundedText(message, MAX_DETAIL_LENGTH),
    retryable: RULES.find((rule) => rule.class === failureClass)?.retryable ?? null,
    resetAt: null,
  }
}

function redactUrl(match: string): string {
  const trailing = /[),.;!?]+$/u.exec(match)?.[0] ?? ''
  const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length)
  try {
    const url = new URL(candidate)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return `${url.toString()}${trailing}`
  } catch {
    return '[REDACTED_URL]'
  }
}

function replaceUnsafeControlCharacters(value: string): string {
  let sanitized = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    const unsafe =
      codePoint <= 0x08 ||
      (codePoint >= 0x0b && codePoint <= 0x0c) ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      codePoint === 0x7f
    sanitized += unsafe ? ' ' : character
  }
  return sanitized
}

/** Credentials, URL secrets and control characters out; the rest stays readable for the log. */
function redact(value: string): string {
  return replaceUnsafeControlCharacters(value)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [REDACTED]')
    .replace(
      /(["'][\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      '$1[REDACTED]$2',
    )
    .replace(
      /((?<![\w-])[\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED]')
    .trim()
}

function boundedText(value: string, maxLength: number): string {
  const redacted = redact(value)
  if (redacted.length <= maxLength) return redacted
  let end = Math.max(0, maxLength - 1)
  // Never cut a surrogate pair in half.
  const finalCodeUnit = redacted.charCodeAt(end - 1)
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1
  return `${redacted.slice(0, end)}…`
}
