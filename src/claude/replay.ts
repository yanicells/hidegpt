// Adapted from T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts
// (recordClaudeAgentSdkReplayTranscript and its replay query) at commit 5c6f2f12.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see THIRD_PARTY_NOTICES.md.
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import { type ReplayEntry, type ReplayTranscript, TurnRefusedError } from '../provider/replayFixture'
import type { ClaudeSdk } from './ClaudeAdapter'

/**
 * Claude replay: the Agent SDK runs in-process, so a recording is the SDK calls
 * the adapter made and what each returned, plus every message a `query()`
 * streamed and every prompt Docs fed it. `recordingSdk` writes those entries
 * around the real SDK (scripts/record-claude-replay.ts); `replaySdk` plays them
 * back to the real adapter and fails on any call the recording did not make.
 *
 * Frames: outbound `{ call, query?, args? }` (a call), `{ query, prompt }` (a
 * prompt Docs fed a query); inbound `{ call, query?, result }` or
 * `{ call, query?, error }` (its answer), `{ query, message }` (a streamed message).
 */

type CallFrame = { readonly call: string; readonly query?: number; readonly args?: ReadonlyArray<unknown> }
type InboundFrame =
  | { readonly call: string; readonly query?: number; readonly result?: unknown; readonly error?: string }
  | { readonly query: number; readonly message: SDKMessage }

type ApplyFlagSettings = Query['applyFlagSettings']

/** The JSON a frame records: functions, abort controllers and undefined drop out. */
const json = (value: unknown): unknown =>
  value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value, (key, entry: unknown) => (typeof entry === 'function' || key === 'abortController' ? undefined : entry)))

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Wraps the real SDK so every call, answer, prompt and message lands in `entries`. */
export function recordingSdk(sdk: ClaudeSdk, entries: ReplayEntry[], allowTurns: boolean): ClaudeSdk {
  let queries = 0
  const outbound = (label: string, frame: unknown) => entries.push({ type: 'expect_outbound', label, frame: json(frame) })
  const inbound = (label: string, frame: unknown) => entries.push({ type: 'emit_inbound', label, frame: json(frame) })
  const record = async <A>(label: string, frame: CallFrame, run: () => Promise<A>): Promise<A> => {
    outbound(label, frame)
    const { args: _args, ...answer } = frame
    try {
      const result = await run()
      inbound(label, { ...answer, result })
      return result
    } catch (error) {
      inbound(label, { ...answer, error: errorText(error) })
      throw error
    }
  }

  return {
    listSessions: (options) => record('listSessions', { call: 'listSessions', args: [options] }, () => sdk.listSessions(options)),
    getSessionMessages: (id, options) =>
      record('getSessionMessages', { call: 'getSessionMessages', args: [id, options] }, () => sdk.getSessionMessages(id, options)),
    getSessionInfo: (id, options) =>
      record('getSessionInfo', { call: 'getSessionInfo', args: [id, options] }, () => sdk.getSessionInfo(id, options)),
    renameSession: (id, title, options) =>
      record('renameSession', { call: 'renameSession', args: [id, title, options] }, () => sdk.renameSession(id, title, options)),
    query: ({ prompt, options }) => {
      const query = ++queries
      outbound('query', { call: 'query', query, args: [options] })
      if (typeof prompt === 'string' && !allowTurns) throw new TurnRefusedError('send a prompt to Claude')
      // The guard sits between Docs and Claude Code: a refused prompt is never passed on.
      // It closes the query instead, and the query's messages end with the refusal.
      let refused: TurnRefusedError | null = null
      let real: Query | undefined
      const guarded =
        typeof prompt === 'string'
          ? prompt
          : (async function* () {
              for await (const message of prompt) {
                if (!allowTurns) {
                  refused = new TurnRefusedError('send a prompt to Claude')
                  real?.close()
                  return
                }
                outbound('prompt', { query, prompt: message })
                yield message
              }
            })()
      const started = sdk.query({ prompt: guarded, ...(options ? { options } : {}) })
      real = started
      const messages = (async function* () {
        for await (const message of started) {
          inbound('message', { query, message })
          yield message
        }
        if (refused) throw refused
      })()
      const call = <A>(name: string, args: ReadonlyArray<unknown>, run: () => Promise<A>) =>
        record(`query.${name}`, { call: name, query, args }, run)
      const methods = {
        initializationResult: () => call('initializationResult', [], () => started.initializationResult()),
        supportedCommands: () => call('supportedCommands', [], () => started.supportedCommands()),
        setModel: (model?: string) => call('setModel', [model], () => started.setModel(model)),
        applyFlagSettings: (settings: Parameters<ApplyFlagSettings>[0]) =>
          call('applyFlagSettings', [settings], () => started.applyFlagSettings(settings)),
        interrupt: () => call('interrupt', [], () => started.interrupt()),
        close: () => {
          outbound('query.close', { call: 'close', query })
          started.close()
        },
      }
      // Only the methods the adapter uses, as FakeClaude does.
      return Object.assign(messages, methods) as unknown as Query
    },
  }
}

// ---- replay -------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Folders differ per machine, and the recorder's were scrubbed. */
const IGNORED_KEYS = new Set(['cwd', 'dir'])
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Compares a recorded outbound frame with what the adapter sent. The adapter
 * mints new document ids with `randomUUID`, so a recorded UUID matches any UUID
 * the first time and binds to it after that.
 */
function same(expected: unknown, actual: unknown, ids: Map<string, string>): boolean {
  if (typeof expected === 'string' && typeof actual === 'string' && UUID.test(expected) && UUID.test(actual)) {
    const bound = ids.get(expected)
    if (bound === undefined) ids.set(expected, actual)
    return (bound ?? actual) === actual
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((entry, i) => same(entry, actual[i], ids))
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)].filter((key) => !IGNORED_KEYS.has(key)))
    return [...keys].every((key) => same(expected[key], actual[key], ids))
  }
  return expected === actual
}

/** Rewrites recorded UUIDs in an answer to the ones the adapter used. */
function rebind(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    let text = value
    for (const [recorded, actual] of ids) text = text.replaceAll(recorded, actual)
    return text
  }
  if (Array.isArray(value)) return value.map((entry) => rebind(entry, ids))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rebind(entry, ids)]))
}

/** A query's message stream: recorded messages are pushed in, the adapter pulls them out. */
class Inbox implements AsyncIterableIterator<SDKMessage> {
  private readonly items: SDKMessage[] = []
  private readonly waiters: Array<(result: IteratorResult<SDKMessage>) => void> = []
  private ended = false

  push(message: SDKMessage) {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: message, done: false })
    else this.items.push(message)
  }

  end() {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    const item = this.items.shift()
    if (item) return Promise.resolve({ value: item, done: false })
    if (this.ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  return(): Promise<IteratorResult<SDKMessage>> {
    this.end()
    return Promise.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator]() {
    return this
  }
}

export type ClaudeReplay = {
  readonly sdk: ClaudeSdk
  /** The first mismatch, if any, and how many recorded entries were never reached. */
  readonly finished: () => { readonly failure: string | null; readonly unused: number }
}

/** An SDK that answers from a recording, in order. */
export function replaySdk(transcript: ReplayTranscript): ClaudeReplay {
  const entries = transcript.entries
  const ids = new Map<string, string>()
  const pending = new Map<string, Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>>()
  const inboxes = new Map<number, Inbox>()
  let cursor = 0
  let queries = 0
  let failure: string | null = null

  const keyOf = (frame: { call: string; query?: number }) => `${frame.query ?? ''}:${frame.call}`

  const fail = (message: string) => {
    failure ??= message
    for (const waiters of pending.values()) for (const waiter of waiters.splice(0)) waiter.reject(new Error(failure))
    for (const inbox of inboxes.values()) inbox.end()
  }

  /** Delivers recorded answers and messages up to the next thing Docs must send. */
  const pump = () => {
    while (!failure && cursor < entries.length) {
      const entry = entries[cursor]!
      if (entry.type === 'expect_outbound') return
      cursor += 1
      if (entry.type === 'runtime_exit') {
        for (const inbox of inboxes.values()) inbox.end()
        continue
      }
      const frame = rebind(entry.frame, ids) as InboundFrame
      if ('message' in frame) {
        inboxes.get(frame.query)?.push(frame.message)
        continue
      }
      const waiter = pending.get(keyOf(frame))?.shift()
      if (!waiter) return fail(`Recorded answer to ${keyOf(frame)} at entry ${cursor - 1} has no call waiting for it.`)
      if (frame.error !== undefined) waiter.reject(new Error(frame.error))
      else waiter.resolve(frame.result)
    }
  }

  /** Matches what Docs sent against the next recorded outbound frame. */
  const expect = (sent: unknown): boolean => {
    pump()
    if (failure) return false
    const entry = entries[cursor]
    const actual = json(sent)
    if (entry?.type !== 'expect_outbound') {
      fail(`Docs sent ${JSON.stringify(actual)} at entry ${cursor}, but the recording has ${entry ? entry.type : 'ended'}.`)
      return false
    }
    if (!same(entry.frame, actual, ids)) {
      fail(`Entry ${cursor} expected ${JSON.stringify(entry.frame)}, but Docs sent ${JSON.stringify(actual)}.`)
      return false
    }
    cursor += 1
    return true
  }

  const call = <A>(frame: CallFrame): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      if (!expect(frame)) return reject(new Error(failure ?? 'Replay failed.'))
      const waiters = pending.get(keyOf(frame)) ?? []
      waiters.push({ resolve: (value) => resolve(value as A), reject })
      pending.set(keyOf(frame), waiters)
      pump()
    })

  const sdk: ClaudeSdk = {
    listSessions: (options) => call({ call: 'listSessions', args: [options] }),
    getSessionMessages: (id, options) => call({ call: 'getSessionMessages', args: [id, options] }),
    getSessionInfo: (id, options) => call({ call: 'getSessionInfo', args: [id, options] }),
    renameSession: (id, title, options) => call({ call: 'renameSession', args: [id, title, options] }),
    query: ({ prompt, options }) => {
      const query = ++queries
      const inbox = new Inbox()
      inboxes.set(query, inbox)
      if (!expect({ call: 'query', query, args: [options] })) inbox.end()
      if (typeof prompt !== 'string') {
        void (async () => {
          for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
            if (!expect({ query, prompt: message })) return
            pump()
          }
        })()
      }
      const ask = <A>(name: string, args: ReadonlyArray<unknown> = []) => call<A>({ call: name, query, args })
      const methods = {
        initializationResult: () => ask('initializationResult'),
        supportedCommands: () => ask('supportedCommands'),
        setModel: (model?: string) => ask<void>('setModel', [model]),
        applyFlagSettings: (settings: Parameters<ApplyFlagSettings>[0]) => ask<void>('applyFlagSettings', [settings]),
        interrupt: () => ask('interrupt'),
        close: () => {
          if (expect({ call: 'close', query })) pump()
          inbox.end()
        },
      }
      return Object.assign(inbox, methods) as unknown as Query
    },
  }

  return { sdk, finished: () => ({ failure, unused: entries.length - cursor }) }
}
