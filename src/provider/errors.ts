import * as Schema from 'effect/Schema'

import { ProviderId } from '../shared/contracts'
import { providerLabel } from '../shared/labels'

/**
 * Every way a provider call can fail, as tagged errors (the T3 Code
 * `Schema.TaggedError` pattern: `Data.TaggedError` semantics plus a schema).
 * Each `message` is the Docs-style sentence the banner shows, so the IPC
 * layer never formats errors itself.
 */

/** A request (or the startup handshake) took longer than its deadline. */
export class ProviderTimeoutError extends Schema.TaggedError<ProviderTimeoutError>()('ProviderTimeoutError', {
  provider: ProviderId,
  operation: Schema.String,
  seconds: Schema.Number,
}) {
  override get message(): string {
    return `${providerLabel(this.provider)} did not answer in ${this.seconds} s. Try again, or use Tools → Refresh.`
  }
}

/** The provider process (or its event stream) ended. `stderr` is the last useful line it printed. */
export class ProcessExitedError extends Schema.TaggedError<ProcessExitedError>()('ProcessExitedError', {
  provider: ProviderId,
  code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    const how = this.code !== null ? ` (exit ${this.code})` : this.signal ? ` (${this.signal})` : ''
    const detail = this.stderr ? `: ${this.stderr}` : ''
    return `${providerLabel(this.provider)} stopped unexpectedly${how}${detail}. Docs is reconnecting.`
  }
}

/** The provider's command is not on PATH. */
export class BinaryMissingError extends Schema.TaggedError<BinaryMissingError>()('BinaryMissingError', {
  provider: ProviderId,
  command: Schema.String,
}) {
  override get message(): string {
    return `${providerLabel(this.provider)} is not installed (Docs could not run “${this.command}”). Install it, then use Tools → Refresh.`
  }
}

/** The provider works but has no signed-in account; `hint` says where to sign in. */
export class NotLoggedInError extends Schema.TaggedError<NotLoggedInError>()('NotLoggedInError', {
  provider: ProviderId,
  hint: Schema.String,
}) {
  override get message(): string {
    return this.hint
  }
}

/** The provider answered with an error. `detail` is already a readable sentence. */
export class ProviderRequestError extends Schema.TaggedError<ProviderRequestError>()('ProviderRequestError', {
  provider: ProviderId,
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail
  }
}

/** A command needs a connection that is not up (still connecting, or failed). */
export class ProviderNotReadyError extends Schema.TaggedError<ProviderNotReadyError>()('ProviderNotReadyError', {
  provider: ProviderId,
  detail: Schema.NullOr(Schema.String),
}) {
  override get message(): string {
    return this.detail ?? `${providerLabel(this.provider)} is not connected yet.`
  }
}

/** The person asked for something that cannot happen right now (nothing to send, no document open…). */
export class CommandRejectedError extends Schema.TaggedError<CommandRejectedError>()('CommandRejectedError', {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

export type ProviderError =
  | ProviderTimeoutError
  | ProcessExitedError
  | BinaryMissingError
  | NotLoggedInError
  | ProviderRequestError
  | ProviderNotReadyError

/** Errors that end a connection; the session manager restarts after these. */
export const endsConnection = (error: ProviderError): boolean =>
  error._tag === 'ProcessExitedError' || error._tag === 'ProviderTimeoutError'

/** The banner sentence for any failure, including defects. */
export function userMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return typeof error === 'string' && error ? error : 'Something went wrong.'
}
