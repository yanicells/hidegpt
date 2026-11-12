import type {
  Agent,
  GlobalEvent,
  GlobalSession,
  Message,
  Part,
  PermissionRequest,
  Project,
  Provider,
  QuestionRequest,
  SessionStatus,
} from '@opencode-ai/sdk/v2/client'
import * as Effect from 'effect/Effect'

import { ProcessExitedError } from '../provider/errors'
import type { MessageWithParts } from './mapping'
import { makeMessageIds, type Connect } from './OpenCodeAdapter'

/**
 * An in-process stand-in for `opencode serve`. It answers the real SDK's
 * HTTP requests through an injected `fetch` (including the SSE event stream),
 * so the adapter, the SDK's URL/body encoding and its SSE parser all run as
 * they do against the real server; only the network and the process are
 * replaced. Library state survives reconnects like OpenCode's on-disk store.
 * Used by tests and demo mode (`HIDEGPT_FAKE=1`).
 */

type Payload = GlobalEvent['payload']
type PropertiesOf<T extends Payload['type']> = Extract<Payload, { type: T }> extends { properties: infer P } ? P : never
type PromptBody = {
  readonly messageID?: string
  readonly model?: { providerID: string; modelID: string }
  readonly agent?: string
  readonly parts?: ReadonlyArray<{ type: string; text?: string; mime?: string; url?: string; synthetic?: boolean }>
}

export type FakeOpenCodeOptions = {
  readonly sessions?: ReadonlyArray<GlobalSession>
  /** Messages per session, oldest first. */
  readonly messages?: Readonly<Record<string, ReadonlyArray<MessageWithParts>>>
  readonly providers?: ReadonlyArray<Provider>
  readonly defaults?: Readonly<Record<string, string>>
  readonly agents?: ReadonlyArray<Agent>
  readonly projects?: ReadonlyArray<Project>
  readonly skills?: ReadonlyArray<{ name: string; description?: string; location: string; content: string }>
  /** What a prompt answers; `null` leaves the turn running (tests drive it with `push`/`finish`). */
  readonly reply?: ((text: string) => string) | null
  /** Milliseconds between streamed words (0 streams synchronously). */
  readonly deltaDelayMs?: number
  /** Sends `server.heartbeat` this often, like the real server (demo mode). */
  readonly heartbeatMs?: number
  /** Ignores the `messageID` a prompt supplies, like older servers. */
  readonly ignoreMessageIds?: boolean
  /** Runs before each request is answered, e.g. to hold one until a test releases it. */
  readonly hold?: (method: string, path: string) => Promise<void> | void
}

export interface FakeOpenCode {
  /** Starts a "process"; each call is a fresh server over the same library. */
  readonly connect: Connect
  /** Every request, in order (the SSE subscription included). */
  readonly requests: ReadonlyArray<{
    readonly method: string
    readonly path: string
    readonly query: URLSearchParams
    readonly body: unknown
  }>
  readonly connections: () => number
  readonly subscriptions: () => number
  readonly sessions: Array<GlobalSession>
  readonly messages: Map<string, Array<MessageWithParts>>
  readonly permissions: Array<PermissionRequest>
  readonly questions: Array<QuestionRequest>
  readonly status: Record<string, SessionStatus>
  /** What permission/question replies answer (`false`: the request already settled). */
  replyResult: boolean
  /** Sends an event to every open subscription. */
  readonly push: (payload: Payload) => void
  /** Ends every open subscription, as if the server closed the stream. */
  readonly endStreams: () => void
  /** Ends the turn running in a session. */
  readonly finish: (sessionId: string) => void
  /** The server process exits with `code`; requests fail until the next `connect`. */
  readonly exit: (code: number) => void
}

const FAKE_PROVIDER: Provider = {
  id: 'fake',
  name: 'Fake',
  source: 'config',
  env: [],
  options: {},
  models: {
    'model-a': {
      id: 'model-a',
      providerID: 'fake',
      api: { id: 'model-a', url: '', npm: '' },
      name: 'Model A',
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 100000, output: 8000 },
      status: 'active',
      options: {},
      headers: {},
      release_date: '2026-01-01',
    },
  },
} as Provider

const agent = (name: string, mode: Agent['mode']): Agent =>
  ({ name, mode, permission: [], options: {} }) as unknown as Agent

export const stubSession = (id: string, title: string, directory = '/tmp/fake', updated = Date.now()): GlobalSession =>
  ({
    id,
    slug: id,
    projectID: 'global',
    directory,
    title,
    version: '1.18.34',
    time: { created: updated, updated },
  }) as GlobalSession

export function userMessage(sessionID: string, id: string, text: string): MessageWithParts {
  return {
    info: {
      id,
      sessionID,
      role: 'user',
      time: { created: Date.now() },
      agent: 'build',
      model: { providerID: 'fake', modelID: 'model-a' },
    },
    parts: [{ id: `${id}-p0`, sessionID, messageID: id, type: 'text', text }],
  }
}

export function agentMessage(sessionID: string, id: string, text: string, parentID = ''): MessageWithParts {
  return {
    info: assistantInfo(sessionID, id, parentID, true),
    parts: [{ id: `${id}-p0`, sessionID, messageID: id, type: 'text', text }],
  }
}

function assistantInfo(sessionID: string, id: string, parentID: string, completed: boolean): Message {
  const now = Date.now()
  return {
    id,
    sessionID,
    role: 'assistant',
    time: completed ? { created: now, completed: now } : { created: now },
    parentID,
    modelID: 'model-a',
    providerID: 'fake',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/tmp/fake', root: '/tmp/fake' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

const PARAM_ROOTS = new Set(['session', 'project', 'permission', 'question'])
const EXACT_ROUTES = new Set([
  'GET /global/health',
  'GET /global/event',
  'GET /experimental/session',
  'GET /session/status',
  'GET /project/current',
])

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })
const notFound = (message: string) => json({ name: 'NotFoundError', data: { message } }, 404)
const encodeCursor = (index: number) => Buffer.from(JSON.stringify({ index })).toString('base64url')
const decodeCursor = (cursor: string) =>
  (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { index: number }).index

export function makeFakeOpenCode(options: FakeOpenCodeOptions = {}): FakeOpenCode {
  const sessions = [...(options.sessions ?? [])]
  const messages = new Map(Object.entries(options.messages ?? {}).map(([id, list]) => [id, [...list]]))
  const providers = options.providers ?? [FAKE_PROVIDER]
  const defaults = options.defaults ?? { fake: 'model-a' }
  const agents = options.agents ?? [agent('build', 'primary'), agent('plan', 'primary'), agent('general', 'subagent')]
  const projects = [...(options.projects ?? [])]
  const permissions: PermissionRequest[] = []
  const questions: QuestionRequest[] = []
  const status: Record<string, SessionStatus> = {}
  const requests: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }> = []
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const exitListeners = new Set<(code: number) => void>()
  /** The live process's exit code, once it exited (late `awaitExit` callers still see it). */
  let exitCode: number | null = null
  const ids = makeMessageIds()
  const encoder = new TextEncoder()
  const reply = options.reply === undefined ? (text: string) => `You asked: ${text}` : options.reply
  let connections = 0
  let subscriptions = 0
  let alive = false
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const push = (payload: Payload) => {
    const frame = encoder.encode(`data: ${JSON.stringify({ directory: '/tmp/fake', payload })}\n\n`)
    for (const stream of streams) stream.enqueue(frame)
  }
  const event = <T extends Payload['type']>(type: T, properties: PropertiesOf<T>) =>
    push({ id: `evt_${ids().slice(4)}`, type, properties } as Payload)

  const endStreams = () => {
    for (const stream of streams) {
      try {
        stream.close()
      } catch {
        // already closed
      }
    }
    streams.clear()
  }

  const append = (sessionId: string, message: MessageWithParts) => {
    const list = messages.get(sessionId) ?? []
    list.push(message)
    messages.set(sessionId, list)
  }

  const finish = (sessionId: string) => {
    status[sessionId] = { type: 'idle' }
    event('session.status', { sessionID: sessionId, status: { type: 'idle' } })
    event('session.idle', { sessionID: sessionId })
  }

  /** Streams an answer word by word, then idles, like a real turn. */
  const answer = (sessionId: string, parentID: string, text: string) => {
    const id = ids()
    const partId = `prt_${id.slice(4)}`
    const words = text.split(/(?<= )/)
    const parts: Part[] = [{ id: partId, sessionID: sessionId, messageID: id, type: 'text', text: '' }]
    event('message.updated', { sessionID: sessionId, info: assistantInfo(sessionId, id, parentID, false) })
    event('message.part.updated', { sessionID: sessionId, part: parts[0]!, time: Date.now() })
    let sent = ''
    const step = (index: number) => {
      if (status[sessionId]?.type !== 'busy') return
      if (index < words.length) {
        const delta = words[index]!
        sent += delta
        event('message.part.delta', { sessionID: sessionId, messageID: id, partID: partId, field: 'text', delta })
        return later(() => step(index + 1))
      }
      const done: Part = { id: partId, sessionID: sessionId, messageID: id, type: 'text', text: sent }
      append(sessionId, { info: assistantInfo(sessionId, id, parentID, true), parts: [done] })
      event('message.part.updated', { sessionID: sessionId, part: done, time: Date.now() })
      finish(sessionId)
    }
    later(() => step(0))
  }
  const later = (run: () => void) => {
    const delay = options.deltaDelayMs ?? 0
    if (delay > 0) setTimeout(run, delay)
    else run()
  }

  const prompt = (sessionId: string, body: PromptBody) => {
    const id = options.ignoreMessageIds || !body.messageID ? ids() : body.messageID
    const parts: Part[] = (body.parts ?? []).map((part, index) =>
      part.type === 'file'
        ? {
            id: `prt_${id.slice(4)}${index}`,
            sessionID: sessionId,
            messageID: id,
            type: 'file',
            mime: part.mime ?? '',
            url: part.url ?? '',
          }
        : {
            id: `prt_${id.slice(4)}${index}`,
            sessionID: sessionId,
            messageID: id,
            type: 'text',
            text: part.text ?? '',
            ...(part.synthetic ? { synthetic: true } : {}),
          },
    )
    const message: MessageWithParts = {
      info: {
        id,
        sessionID: sessionId,
        role: 'user',
        time: { created: Date.now() },
        agent: body.agent ?? 'build',
        model: body.model ?? { providerID: 'fake', modelID: 'model-a' },
      },
      parts,
    }
    append(sessionId, message)
    status[sessionId] = { type: 'busy' }
    event('message.updated', { sessionID: sessionId, info: message.info })
    for (const part of parts) event('message.part.updated', { sessionID: sessionId, part, time: Date.now() })
    event('session.status', { sessionID: sessionId, status: { type: 'busy' } })
    const text = parts.flatMap((part) => (part.type === 'text' && !part.synthetic ? [part.text] : [])).join('\n')
    if (reply) answer(sessionId, id, reply(text))
  }

  const sse = () => {
    subscriptions += 1
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        controller = stream
        streams.add(stream)
        stream.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ directory: '/tmp/fake', payload: { id: 'evt_connected', type: 'server.connected', properties: {} } })}\n\n`,
          ),
        )
      },
      cancel() {
        if (controller) streams.delete(controller)
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  const route = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const text = request.method === 'GET' ? '' : await request.text()
    const body: unknown = text ? JSON.parse(text) : undefined
    requests.push({ method: request.method, path: url.pathname, query: url.searchParams, body })
    if (!alive) throw new TypeError('fetch failed')
    await options.hold?.(request.method, url.pathname)
    const q = url.searchParams
    const segments = url.pathname.split('/').filter(Boolean)
    const exact = `${request.method} ${url.pathname}`
    const patterned = `${request.method} /${segments.map((segment, index) => (index === 1 && PARAM_ROOTS.has(segments[0] ?? '') ? ':id' : segment)).join('/')}`
    const key = EXACT_ROUTES.has(exact) ? exact : patterned
    const id = segments[1] ?? ''
    switch (key) {
      case 'GET /global/health':
        return json({ healthy: true, version: '1.18.34' })
      case 'GET /global/event':
        return sse()
      case 'GET /config/providers':
        return json({ providers, default: defaults })
      case 'GET /agent':
        return json(agents)
      case 'GET /project':
        return json(projects)
      case 'GET /project/current': {
        const directory = q.get('directory') ?? ''
        const project = projects.find((item) => item.worktree === directory)
        return json(project ?? { id: 'global', worktree: '/', time: { created: 0 }, sandboxes: [] })
      }
      case 'PATCH /project/:id': {
        const index = projects.findIndex((item) => item.id === id)
        if (index === -1) return notFound(`Project not found: ${id}`)
        projects[index] = { ...projects[index]!, name: (body as { name?: string }).name }
        event('project.updated', projects[index] as never)
        return json(projects[index])
      }
      case 'GET /skill':
        return json(options.skills ?? [])
      case 'GET /experimental/session': {
        const search = q.get('search')?.toLowerCase()
        const cursor = Number(q.get('cursor') ?? 0)
        const limit = Number(q.get('limit') ?? 100)
        const listed = [...sessions]
          .filter((session) => !session.parentID && (!search || session.title.toLowerCase().includes(search)))
          .sort((a, b) => b.time.updated - a.time.updated)
          .filter((session) => !cursor || session.time.updated < cursor)
          .slice(0, limit)
        const last = listed[listed.length - 1]
        return json(listed, 200, listed.length === limit && last ? { 'x-next-cursor': String(last.time.updated) } : {})
      }
      case 'GET /session/status':
        return json(status)
      case 'POST /session': {
        const options = (body ?? {}) as { title?: string; agent?: string }
        const created = stubSession(
          `ses_${ids().slice(4)}`,
          options.title ?? 'New session',
          q.get('directory') ?? '/tmp/fake',
        )
        sessions.push(created)
        event('session.created', { sessionID: created.id, info: created })
        return json(created)
      }
      case 'GET /session/:id': {
        const session = sessions.find((item) => item.id === id)
        return session ? json(session) : notFound(`Session not found: ${id}`)
      }
      case 'PATCH /session/:id': {
        const index = sessions.findIndex((item) => item.id === id)
        if (index === -1) return notFound(`Session not found: ${id}`)
        const title = (body as { title?: string }).title
        sessions[index] = {
          ...sessions[index]!,
          ...(title ? { title } : {}),
          time: { ...sessions[index]!.time, updated: Date.now() },
        }
        event('session.updated', { sessionID: id, info: sessions[index]! })
        return json(sessions[index])
      }
      case 'GET /session/:id/children':
        if (!sessions.some((item) => item.id === id)) return notFound(`Session not found: ${id}`)
        return json(sessions.filter((item) => item.parentID === id))
      case 'GET /session/:id/message': {
        const list = messages.get(id) ?? []
        const limit = Number(q.get('limit') ?? list.length)
        const before = q.get('before')
        const end = before ? decodeCursor(before) : list.length
        const start = Math.max(0, end - limit)
        return json(list.slice(start, end), 200, start > 0 ? { 'x-next-cursor': encodeCursor(start) } : {})
      }
      case 'POST /session/:id/prompt_async':
        if (!sessions.some((item) => item.id === id)) return notFound(`Session not found: ${id}`)
        prompt(id, (body ?? {}) as PromptBody)
        return new Response(null, { status: 204 })
      case 'POST /session/:id/abort':
        if (status[id]?.type === 'busy') {
          event('session.error', {
            sessionID: id,
            error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
          })
          finish(id)
        }
        return json(true)
      case 'GET /permission':
        return json(permissions)
      case 'GET /question':
        return json(questions)
      case 'POST /permission/:id/reply':
      case 'POST /question/:id/reply':
      case 'POST /question/:id/reject': {
        const list: Array<{ id: string; sessionID: string }> = segments[0] === 'permission' ? permissions : questions
        const index = list.findIndex((item) => item.id === id)
        if (!fake.replyResult || index === -1) return json(false)
        const [settled] = list.splice(index, 1)
        if (segments[0] === 'permission') {
          event('permission.replied', {
            sessionID: settled!.sessionID,
            requestID: id,
            reply: (body as { reply: 'once' | 'always' | 'reject' }).reply,
          })
        } else if (segments[2] === 'reply') {
          event('question.replied', {
            sessionID: settled!.sessionID,
            requestID: id,
            answers: (body as { answers: string[][] }).answers,
          })
        } else {
          event('question.rejected', { sessionID: settled!.sessionID, requestID: id })
        }
        return json(true)
      }
      default:
        return json({ _tag: 'BadRequest' }, 400)
    }
  }

  const handler = (input: RequestInfo | URL, init?: RequestInit) =>
    route(input instanceof Request ? input : new Request(input, init))

  const fake: FakeOpenCode = {
    connect: Effect.gen(function* () {
      connections += 1
      alive = true
      exitCode = null
      const generation = connections
      if (options.heartbeatMs && !heartbeat) {
        heartbeat = setInterval(
          () => push({ id: `evt_${ids().slice(4)}`, type: 'server.heartbeat', properties: {} } as unknown as Payload),
          options.heartbeatMs,
        )
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (connections !== generation) return
          alive = false
          endStreams()
          if (heartbeat) clearInterval(heartbeat)
          heartbeat = null
        }),
      )
      return {
        url: 'http://fake-opencode.local',
        fetch: handler as typeof fetch,
        awaitExit: Effect.callback<never, ProcessExitedError>((resume) => {
          const listener = (code: number) =>
            resume(Effect.fail(new ProcessExitedError({ provider: 'opencode', code, signal: null })))
          if (exitCode !== null && connections === generation) return listener(exitCode)
          exitListeners.add(listener)
          return Effect.sync(() => exitListeners.delete(listener))
        }),
      }
    }),
    requests,
    connections: () => connections,
    subscriptions: () => subscriptions,
    sessions,
    messages,
    permissions,
    questions,
    status,
    replyResult: true,
    push,
    endStreams,
    finish,
    exit: (code) => {
      alive = false
      exitCode = code
      endStreams()
      for (const listener of Array.from(exitListeners)) listener(code)
      exitListeners.clear()
    },
  }
  return fake
}
