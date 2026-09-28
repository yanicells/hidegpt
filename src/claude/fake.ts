import type {
  ModelInfo,
  Options,
  Query,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'

import { Inbox } from './inbox'
import type { ClaudeSdk } from './session'

const MODELS: ModelInfo[] = [
  { value: 'default', displayName: 'Default (recommended)', description: '', supportedEffortLevels: ['low', 'high'] },
  { value: 'haiku', displayName: 'Haiku', description: '' },
]

const COMMANDS: SlashCommand[] = [
  { name: 'humanizer', description: 'Rewrite text so it reads naturally', argumentHint: '' },
  { name: 'compact', description: 'Built in', argumentHint: '', builtin: true },
]

export type FakeClaude = ClaudeSdk & {
  /** Prompts each fake Claude Code process received. */
  sent: SDKUserMessage[]
  /** Options each process was started with. */
  started: Options[]
  renamed: [string, string][]
}

/**
 * In-memory stand-in for the Agent SDK. Each prompt streams back an echo;
 * a prompt containing "run" first asks permission for a Bash command.
 */
export function createFakeClaudeSdk(options?: {
  sessions?: SDKSessionInfo[]
  transcripts?: Record<string, SessionMessage[]>
}) {
  const now = Date.now()
  const sessions: SDKSessionInfo[] = options?.sessions ?? [
    {
      sessionId: 'claude-1',
      summary: 'Seminar reading notes',
      lastModified: now - 3_600_000,
      firstPrompt: 'Summarize the reading',
    },
    {
      sessionId: 'claude-2',
      summary: 'Essay feedback',
      lastModified: now - 90_000_000,
      firstPrompt: 'Review my essay',
    },
  ]
  const transcripts = options?.transcripts ?? {}
  const sent: SDKUserMessage[] = []
  const started: Options[] = []
  const renamed: [string, string][] = []

  const fake: FakeClaude = {
    sent,
    started,
    renamed,
    listSessions: async () => sessions,
    getSessionMessages: async (id) => transcripts[id] ?? [],
    renameSession: async (id, title) => {
      renamed.push([id, title])
    },
    query: ({ prompt, options: opts = {} }) => {
      started.push(opts)
      const out = new Inbox<SDKMessage>()
      const session_id = opts.resume ?? opts.sessionId ?? 'fake'
      void (async () => {
        if (typeof prompt === 'string') return
        let turn = 0
        for await (const message of prompt) {
          sent.push(message)
          turn += 1
          const content = message.message.content
          const text =
            typeof content === 'string' ? content : content.map((part) => ('text' in part ? part.text : '')).join('')
          if (text.includes('run') && opts.canUseTool) {
            await opts.canUseTool(
              'Bash',
              { command: 'ls' },
              { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'req-1' },
            )
          }
          const id = `msg-${session_id}-${turn}`
          const frames = [
            { type: 'message_start', message: { id } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is ' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `a reply to: ${text}` } },
          ]
          for (const event of frames)
            out.push({ type: 'stream_event', event, parent_tool_use_id: null, session_id } as unknown as SDKMessage)
          out.push({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'done',
            session_id,
          } as unknown as SDKMessage)
        }
      })()
      const controls = {
        supportedModels: async () => MODELS,
        supportedCommands: async () => COMMANDS,
        interrupt: async () => undefined,
        setModel: async () => {},
        applyFlagSettings: async () => {},
        close: () => out.end(),
      }
      return Object.assign(out[Symbol.asyncIterator](), controls) as unknown as Query
    },
  }
  return fake
}
