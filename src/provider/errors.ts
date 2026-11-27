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

/** The banner sentence for a defect; the cause itself goes to the log under a report id. */
export const DEFECT_MESSAGE = 'Something went wrong. Docs saved a report.'

/** A bug (a defect) ended the connection. The log has the cause under `reportId`. */
export class ProviderDefectError extends Schema.TaggedError<ProviderDefectError>()('ProviderDefectError', {
  provider: ProviderId,
  reportId: Schema.String,
}) {
  override get message(): string {
    return 'Something went wrong. Docs saved a report and is reconnecting.'
  }
}

export type ProviderError =
  | ProviderDefectError
  | ProviderTimeoutError
  | ProcessExitedError
  | BinaryMissingError
  | NotLoggedInError
  | ProviderRequestError
  | ProviderNotReadyError

/** Errors that end a connection; the session manager restarts after these. */
export const endsConnection = (error: ProviderError): boolean =>
  error._tag === 'ProcessExitedError' || error._tag === 'ProviderTimeoutError' || error._tag === 'ProviderDefectError'

/** A failure Docs expects (one of the errors above); anything else is a defect. */
export const isExpectedError: (error: unknown) => error is ProviderError | CommandRejectedError = Schema.is(
  Schema.Union([
    ProviderDefectError,
    ProviderTimeoutError,
    ProcessExitedError,
    BinaryMissingError,
    NotLoggedInError,
    ProviderRequestError,
    ProviderNotReadyError,
    CommandRejectedError,
  ]),
)

/**
 * The banner sentence for a failure. Tagged errors already carry a Docs-style
 * sentence; anything else is a defect, whose raw text never reaches the page.
 */
export function bannerMessage(error: unknown): string {
  if (isExpectedError(error) && error.message) return error.message
  return typeof error === 'string' && error ? error : DEFECT_MESSAGE
}
