import { randomUUID } from 'node:crypto'

import type {
  AccountInfo,
  CanUseTool,
  ModelInfo,
  Options,
  Query,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
  SlashCommand,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk'

import type { ClaudeSdk } from './ClaudeAdapter'

/**
 * An in-process Claude Agent SDK for tests and `HIDEGPT_FAKE=1`: `query()`
 * reads the real prompt stream and answers with the frames Claude Code
 * writes (partial `stream_event`s, the final `assistant` frame, `result`),
 * and transcripts live in memory. Only the process boundary is replaced.
 */

export type FakeClaudeOptions = {
  readonly sessions?: ReadonlyArray<SDKSessionInfo>
  readonly transcripts?: Readonly<Record<string, ReadonlyArray<SessionMessage>>>
  readonly models?: ReadonlyArray<ModelInfo>
  readonly commands?: ReadonlyArray<SlashCommand>
  readonly account?: AccountInfo
  /** The answer to a question, streamed word by word; null leaves the turn to the test. */
  readonly reply?: ((text: string) => string) | null
  readonly deltaDelayMs?: number
  /** `initializationResult()` never answers (a Claude Code stuck at startup). */
  readonly hangInit?: boolean
  /** `interrupt()` never answers. */
  readonly hangInterrupt?: boolean
  /**
   * A harmless command that stands in for the Claude Code CLI: when Docs passes
   * `spawnClaudeCodeProcess`, each query starts it through that hook, as the SDK does.
   */
  readonly process?: { readonly command: string; readonly args: ReadonlyArray<string>; readonly env?: Record<string, string | undefined> }
}

/** One `query()` call: what Docs started it with and what it sent. */
export type FakeQuery = {
  readonly options: Options
  readonly prompts: SDKUserMessage[]
  readonly calls: string[]
  /** What `spawnClaudeCodeProcess` returned (a Node child, so it has a pid), when the fake started one. */
  readonly child: (SpawnedProcess & { readonly pid?: number }) | null
  closed: boolean
  /** Writes a frame as Claude Code would. */
  readonly push: (message: SDKMessage) => void
  /** Claude Code exits: the frame stream ends, with or without an error. */
  readonly exit: (error?: Error) => void
  /** Calls the `canUseTool` callback Docs passed, as Claude Code does before a tool runs. */
  readonly askTool: (
    tool: string,
    input: Record<string, unknown>,
    toolUseID: string,
    prompt?: { title?: string; displayName?: string; description?: string; decisionReason?: string },
  ) => { result: ReturnType<CanUseTool>; abort: () => void }
}

export type FakeClaude = {
  readonly sdk: ClaudeSdk
  readonly queries: FakeQuery[]
  readonly sessions: SDKSessionInfo[]
  readonly transcripts: Map<string, SessionMessage[]>
  readonly renames: Array<{ sessionId: string; title: string }>
}

export const FAKE_MODELS: ReadonlyArray<ModelInfo> = [
  { value: 'default', displayName: 'Default', description: 'Recommended', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', displayName: 'Haiku', description: 'Fast', supportsEffort: false },
]

/** Async-iterable frames with push/end, like the SDK's own message stream. */
class Frames implements AsyncIterableIterator<SDKMessage> {
  private queue: SDKMessage[] = []
  private waiting: Array<{ resolve: (result: IteratorResult<SDKMessage>) => void; reject: (error: Error) => void }> = []
  private ended: { error: Error | null } | null = null

  push(message: SDKMessage) {
    if (this.ended) return
    const waiter = this.waiting.shift()
    if (waiter) waiter.resolve({ value: message, done: false })
    else this.queue.push(message)
  }

  end(error?: Error) {
    if (this.ended) return
    this.ended = { error: error ?? null }
    for (const waiter of this.waiting.splice(0)) {
      if (error) waiter.reject(error)
      else waiter.resolve({ value: undefined, done: true })
    }
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve({ value: queued, done: false })
    if (this.ended) return this.ended.error ? Promise.reject(this.ended.error) : Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }))
  }

  return(): Promise<IteratorResult<SDKMessage>> {
    this.end()
    return Promise.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator]() {
    return this
  }
}

export function stubSession(sessionId: string, title: string, cwd: string, lastModified = Date.now()): SDKSessionInfo {
  return { sessionId, summary: title, firstPrompt: title, lastModified, cwd }
}

export function transcriptUser(sessionId: string, uuid: string, text: string): SessionMessage {
  return { type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: text } }
}

export function transcriptAgent(sessionId: string, uuid: string, text: string): SessionMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] },
  }
}

/** The frames are typed loosely: the SDK's own types carry dozens of usage fields a fake has no use for. */
const frame = (message: Record<string, unknown>) => message as unknown as SDKMessage

export const streamEvent = (event: Record<string, unknown>) =>
  frame({ type: 'stream_event', event, parent_tool_use_id: null, uuid: randomUUID(), session_id: '' })

export const assistantFrame = (id: string, content: ReadonlyArray<Record<string, unknown>>) =>
  frame({ type: 'assistant', message: { id, role: 'assistant', content }, parent_tool_use_id: null, uuid: randomUUID(), session_id: '' })

export const resultFrame = (fields: Record<string, unknown> = {}) =>
  frame({ type: 'result', subtype: 'success', is_error: false, result: '', errors: [], uuid: randomUUID(), session_id: '', ...fields })

const textOf = (message: SDKUserMessage) => {
  const content = message.message.content
  if (typeof content === 'string') return content
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

export function makeFakeClaude(options: FakeClaudeOptions = {}): FakeClaude {
  const sessions = [...(options.sessions ?? [])]
  const transcripts = new Map(Object.entries(options.transcripts ?? {}).map(([id, messages]) => [id, [...messages]]))
  const renames: FakeClaude['renames'] = []
  const queries: FakeQuery[] = []
  const reply = options.reply === undefined ? (text: string) => `You asked: ${text}` : options.reply
  const account = options.account ?? { email: 'student@example.edu', tokenSource: 'claude.ai', subscriptionType: 'pro' }

  const record = (sessionId: string, message: SessionMessage, cwd: string, prompt?: string) => {
    transcripts.set(sessionId, [...(transcripts.get(sessionId) ?? []), message])
    const existing = sessions.find((item) => item.sessionId === sessionId)
    if (existing) {
      existing.lastModified = Date.now()
      return
    }
    sessions.unshift(stubSession(sessionId, prompt ?? 'Untitled', cwd))
  }

  const query: ClaudeSdk['query'] = ({ prompt, options: queryOptions = {} }) => {
    const frames = new Frames()
    const sessionId = queryOptions.resume ?? queryOptions.sessionId ?? randomUUID()
    const cwd = queryOptions.cwd ?? '/'
    let answering: { timer: ReturnType<typeof setTimeout> | null; stop: () => void } | null = null
    // Like the SDK's forwarded signal: it aborts once the query closes.
    const forwarded = new AbortController()
    const spawn = queryOptions.spawnClaudeCodeProcess
    const child =
      options.process && spawn
        ? spawn({
            command: options.process.command,
            args: [...options.process.args],
            cwd,
            env: options.process.env ?? { ...process.env },
            signal: forwarded.signal,
          })
        : null
    const fake: FakeQuery = {
      options: queryOptions,
      prompts: [],
      calls: [],
      child,
      closed: false,
      push: (message) => frames.push(message),
      exit: (error) => {
        answering?.stop()
        frames.end(error)
      },
      askTool: (tool, input, toolUseID, prompt) => {
        const abort = new AbortController()
        const canUseTool = queryOptions.canUseTool
        if (!canUseTool) throw new Error('Docs passed no canUseTool')
        return { result: canUseTool(tool, input, { ...prompt, signal: abort.signal, toolUseID, requestId: toolUseID }), abort: () => abort.abort() }
      },
    }
    queries.push(fake)

    /** Streams `text` the way Claude Code does with partial messages on. */
    const answer = (text: string) => {
      const id = `msg_${randomUUID().slice(0, 8)}`
      const words = text.split(/(?<= )/)
      let stopped = false
      answering = {
        timer: null,
        stop: () => {
          stopped = true
          if (answering?.timer) clearTimeout(answering.timer)
          answering = null
        },
      }
      frames.push(streamEvent({ type: 'message_start', message: { id } }))
      frames.push(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      const step = (index: number) => {
        if (stopped) return
        if (index < words.length) {
          frames.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words[index] } }))
          const delay = options.deltaDelayMs ?? 0
          if (delay > 0 && answering) answering.timer = setTimeout(() => step(index + 1), delay)
          else step(index + 1)
          return
        }
        answering = null
        frames.push(assistantFrame(id, [{ type: 'text', text }]))
        record(sessionId, transcriptAgent(sessionId, randomUUID(), text), cwd)
        frames.push(resultFrame({ result: text }))
      }
      step(0)
    }

    void (async () => {
      if (typeof prompt === 'string') return
      try {
        for await (const message of prompt) {
          if (fake.closed) break
          fake.prompts.push(message)
          const text = textOf(message)
          record(sessionId, { ...transcriptUser(sessionId, randomUUID(), text), message: message.message }, cwd, text)
          if (reply) answer(reply(text))
        }
      } finally {
        // Claude Code exits once its input closes.
        frames.end()
      }
    })()

    const methods = {
      initializationResult: () => {
        fake.calls.push('initializationResult')
        if (options.hangInit) return new Promise<never>(() => {})
        return Promise.resolve({
          commands: options.commands ?? [],
          agents: [],
          output_style: 'default',
          available_output_styles: [],
          models: options.models ?? FAKE_MODELS,
          account,
        })
      },
      supportedCommands: () => {
        fake.calls.push('supportedCommands')
        return Promise.resolve(options.commands ?? [])
      },
      setModel: (model?: string) => {
        fake.calls.push(`setModel:${model}`)
        return Promise.resolve()
      },
      applyFlagSettings: (settings: { effortLevel?: string | null }) => {
        fake.calls.push(`effort:${settings.effortLevel}`)
        return Promise.resolve()
      },
      interrupt: () => {
        fake.calls.push('interrupt')
        if (options.hangInterrupt) return new Promise<never>(() => {})
        if (answering) {
          answering.stop()
          frames.push(resultFrame({ subtype: 'error_during_execution', is_error: true, errors: ['Request was aborted.'], terminal_reason: 'aborted_streaming' }))
        }
        return Promise.resolve(undefined)
      },
      close: () => {
        fake.closed = true
        answering?.stop()
        frames.end()
        forwarded.abort()
      },
    }
    // The SDK listens for "error" (a failed spawn, or the abort on close) and so does the fake.
    child?.on('error', () => {})
    // The frame stream ends when the CLI exits, as the SDK's transport does.
    child?.once('exit', (code) => frames.end(fake.closed ? undefined : new Error(`Claude Code process exited with code ${code}`)))
    queryOptions.abortController?.signal.addEventListener('abort', () => methods.close(), { once: true })
    return Object.assign(frames, methods) as unknown as Query
  }

  const sdk: ClaudeSdk = {
    query,
    listSessions: async (listOptions) =>
      [...sessions].sort((a, b) => b.lastModified - a.lastModified).slice(0, listOptions?.limit ?? sessions.length),
    getSessionMessages: async (sessionId) => [...(transcripts.get(sessionId) ?? [])],
    getSessionInfo: async (sessionId) => sessions.find((item) => item.sessionId === sessionId),
    renameSession: async (sessionId, title) => {
      renames.push({ sessionId, title })
      const existing = sessions.find((item) => item.sessionId === sessionId)
      if (existing) existing.customTitle = title
    },
  }
  return { sdk, queries, sessions, transcripts, renames }
}
