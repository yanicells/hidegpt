// Adapted from T3 Code (https://github.com/pingdotgg/t3code), apps/server/scripts/codexReplayRecordingRecords.ts
// at commit 5c6f2f12. Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import { readFileSync } from 'node:fs'

/**
 * Replay fixtures: a provider conversation recorded from the real CLI, one JSON
 * record per line. The first line names the provider, protocol, CLI version and
 * scenario; the rest are `expect_outbound` (what the adapter sent),
 * `emit_inbound` (what the CLI answered) and a closing `runtime_exit`, the same
 * entries as T3 Code's replay transcripts. Recorders live in `scripts/`; see
 * docs/replay-fixtures.md.
 */

export type ReplayEntry =
  | { readonly type: 'expect_outbound'; readonly label?: string; readonly frame: unknown }
  | { readonly type: 'emit_inbound'; readonly label?: string; readonly frame: unknown }
  | { readonly type: 'runtime_exit'; readonly status: 'success' | 'error' | 'cancelled'; readonly error?: unknown }

export type ReplayTranscript = {
  readonly provider: string
  readonly protocol: string
  readonly version: string
  readonly scenario: string
  readonly metadata?: Record<string, unknown>
  readonly entries: ReadonlyArray<ReplayEntry>
}

/** Reads a fixture written by `encodeTranscript`. */
export function readTranscript(path: string): ReplayTranscript {
  const [header, ...entries] = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  if (header?.type !== 'transcript_start') throw new Error(`${path} does not start with a transcript_start record.`)
  const { type: _type, ...start } = header
  return { ...(start as Omit<ReplayTranscript, 'entries'>), entries: entries as ReplayEntry[] }
}

export function encodeTranscript(transcript: ReplayTranscript): string {
  const { entries, ...start } = transcript
  return `${[{ type: 'transcript_start', ...start }, ...entries].map((record) => JSON.stringify(record)).join('\n')}\n`
}

// ---- turn gate ------------------------------------------------------------------

/**
 * Recording a turn sends a prompt to a real model, which only a person may
 * start. Recorders check this before anything that would send one.
 */
export const turnsAllowed = (env: NodeJS.ProcessEnv = process.env) => env.HIDEGPT_RECORD_TURNS === '1'

export class TurnRefusedError extends Error {
  constructor(what: string) {
    super(`Refusing to ${what}: recording a turn sends a prompt to a real model. A person must set HIDEGPT_RECORD_TURNS=1.`)
    this.name = 'TurnRefusedError'
  }
}

// ---- scrubbing --------------------------------------------------------------------

/** The machine a recording came from; every value here is replaced before it is written. */
export type RecordingMachine = {
  readonly home: string
  readonly username: string
  readonly hostname: string
  /** Throwaway folders the recorder made (the CLI's home, the workspace), longest first. */
  readonly scratch: ReadonlyArray<readonly [path: string, placeholder: string]>
}

export const REPLAY_HOME = '/home/replay-user'
const REPLAY_USER = 'replay-user'
const REPLAY_HOST = 'replay-host'
const REPLAY_EMAIL = 'replay-user@example.com'
const REDACTED = '<redacted>'

/** Keys whose string values are secrets or per-install ids, whatever they hold. */
const SECRET_KEYS = /^(?:.*token|.*secret|.*password|apikey|api_key|authorization|cookie|installationid|accountid|organizationid|orguuid|accountuuid)$/i
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
/** JWTs and provider API keys. */
const TOKEN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g
const MAC_TEMP = /(?:\/private)?\/var\/folders\/[^\s"'/]+\/[^\s"'/]+\/T/g
/** Another account's home folder, for paths the recorder did not know about. */
const OTHER_HOME = /\/(?:Users|home)\/(?!replay-user\b)[^\s"'/\\]+/g

const word = (text: string) => new RegExp(`\\b${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')

function scrubString(value: string, machine: RecordingMachine): string {
  let text = value
  for (const [path, placeholder] of machine.scratch) text = text.replaceAll(path, placeholder)
  text = text.replaceAll(machine.home, REPLAY_HOME).replace(MAC_TEMP, '/tmp').replace(OTHER_HOME, REPLAY_HOME)
  text = text.replace(EMAIL, REPLAY_EMAIL).replace(TOKEN, REDACTED)
  if (machine.hostname) text = text.replaceAll(machine.hostname, REPLAY_HOST)
  // The username last, and only as a whole word, so it cannot eat into other words.
  if (machine.username.length >= 3) text = text.replace(word(machine.username), REPLAY_USER)
  return text
}

/** Replaces emails, home and temp paths, the username, the hostname and secrets anywhere in a frame. */
export function scrub(value: unknown, machine: RecordingMachine, key?: string): unknown {
  if (key !== undefined && SECRET_KEYS.test(key) && typeof value === 'string' && value) return REDACTED
  if (typeof value === 'string') return scrubString(value, machine)
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, machine))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, scrub(entry, machine, entryKey)]))
}

/**
 * What must never appear in a committed fixture. Returns the offending matches;
 * the fixture test runs it over every file, and recorders refuse to write a
 * transcript that fails it.
 */
export function leaks(text: string, machine: Pick<RecordingMachine, 'home' | 'username'>): ReadonlyArray<string> {
  const found = [
    ...[...text.matchAll(EMAIL)].map((match) => match[0]).filter((email) => email !== REPLAY_EMAIL),
    ...[...text.matchAll(TOKEN)].map((match) => match[0]),
    ...[...text.matchAll(MAC_TEMP)].map((match) => match[0]),
    ...[...text.matchAll(OTHER_HOME)].map((match) => match[0]),
  ]
  if (text.includes(machine.home)) found.push(machine.home)
  if (machine.username.length >= 3 && word(machine.username).test(text)) found.push(machine.username)
  return found
}
