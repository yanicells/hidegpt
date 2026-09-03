import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * Minimal client for a headless `opencode serve` instance.
 * Only endpoints served by the local OpenAPI (/doc) are used:
 * global health, sessions, config providers, agents, projects,
 * permission and question replies, and the SSE event stream.
 */

export type OpenSession = {
  id: string
  title: string
  directory: string
  projectID: string
  agent: string
  model: { providerID: string; modelID: string } | null
  time: { created: number; updated: number }
}

export type OpenMessagePart = {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  tool?: string
  state?: { status: string; input?: unknown; output?: string; title?: string }
  synthetic?: boolean
}

export type OpenMessage = {
  info: { id: string; sessionID: string; role: 'user' | 'assistant'; time: { created: number } }
  parts: OpenMessagePart[]
}

export type OpenEvent = { id: string; type: string; properties: Record<string, unknown> }

export type OpenProviderModel = { id: string; providerID: string; name: string }
export type OpenAgent = { name: string; mode: string }
export type OpenProject = { id: string; name: string }

export type PermissionAsked = {
  id: string
  sessionID: string
  permission: string
  patterns?: string[]
}

export type QuestionOption = { label: string; description: string }
export type QuestionAsked = {
  id: string
  sessionID: string
  questions: { header: string; question: string; options: QuestionOption[]; multiple?: boolean }[]
}

async function readJson(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`opencode ${what} failed (${response.status}): ${body.slice(0, 200)}`.trim())
  }
  if (response.status === 204) return null
  return response.json()
}

export class OpenCodeClient {
  constructor(readonly baseUrl: string) {}

  private async call<T>(path: string, init?: RequestInit, what?: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
    return (await readJson(response, what ?? path)) as T
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    return this.call('/global/health', undefined, 'health')
  }

  async listSessions(opts?: { search?: string; limit?: number }): Promise<OpenSession[]> {
    const params = new URLSearchParams()
    if (opts?.search?.trim()) params.set('search', opts.search.trim())
    if (opts?.limit) params.set('limit', String(opts.limit))
    const query = params.size > 0 ? `?${params}` : ''
    return this.call(`/session${query}`, undefined, 'session.list')
  }

  async createSession(opts?: {
    title?: string
    agent?: string
    model?: { providerID: string; modelID: string }
  }): Promise<OpenSession> {
    // Note: session.create takes {id, providerID}; session.prompt takes {modelID, providerID}.
    const model = opts?.model ? { id: opts.model.modelID, providerID: opts.model.providerID } : undefined
    return this.call(
      '/session',
      { method: 'POST', body: JSON.stringify({ title: opts?.title, agent: opts?.agent, model }) },
      'session.create',
    )
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.call(`/session/${sessionId}`, { method: 'DELETE' }, 'session.delete')
  }

  async listMessages(sessionId: string, limit = 100): Promise<OpenMessage[]> {
    return this.call(`/session/${sessionId}/message?limit=${limit}`, undefined, 'session.messages')
  }

  /** Accepted immediately (204); the turn then streams over /event. */
  async promptAsync(
    sessionId: string,
    opts: { model?: { providerID: string; modelID: string }; agent?: string; text: string },
  ): Promise<void> {
    await this.call(
      `/session/${sessionId}/prompt_async`,
      {
        method: 'POST',
        body: JSON.stringify({
          model: opts.model,
          agent: opts.agent,
          parts: [{ type: 'text', text: opts.text }],
        }),
      },
      'session.prompt_async',
    )
  }

  async abort(sessionId: string): Promise<void> {
    await this.call(`/session/${sessionId}/abort`, { method: 'POST' }, 'session.abort')
  }

  async listProviders(): Promise<{ id: string; models: Record<string, { id: string; name?: string }> }[]> {
    const data = await this.call<{
      providers: { id: string; models: Record<string, { id: string; name?: string }> }[]
    }>('/config/providers', undefined, 'config.providers')
    return data.providers ?? []
  }

  async providerDefaults(): Promise<Record<string, string>> {
    try {
      const data = await this.call<{ default?: Record<string, string> }>(
        '/config/providers',
        undefined,
        'config.providers',
      )
      return data.default ?? {}
    } catch {
      return {}
    }
  }

  async listModels(): Promise<OpenProviderModel[]> {
    const providers = await this.listProviders()
    const out: OpenProviderModel[] = []
    for (const provider of providers) {
      for (const [id, model] of Object.entries(provider.models ?? {})) {
        out.push({ id, providerID: provider.id, name: model.name ?? id })
      }
    }
    return out
  }

  async listAgents(): Promise<OpenAgent[]> {
    const data = await this.call<{ name: string; mode?: string }[] | { agents: { name: string; mode?: string }[] }>(
      '/agent',
      undefined,
      'app.agents',
    )
    const agents = Array.isArray(data) ? data : (data.agents ?? [])
    return agents.map((agent) => ({ name: agent.name, mode: agent.mode ?? 'primary' }))
  }

  async listProjects(): Promise<OpenProject[]> {
    try {
      const data = await this.call<{ id: string; name?: string }[] | { projects: { id: string; name?: string }[] }>(
        '/project',
        undefined,
        'project.list',
      )
      const projects = Array.isArray(data) ? data : (data.projects ?? [])
      return projects.map((project) => ({ id: project.id, name: project.name ?? project.id }))
    } catch {
      return []
    }
  }

  async replyPermission(requestId: string, accept: boolean): Promise<void> {
    await this.call(
      `/permission/${requestId}/reply`,
      { method: 'POST', body: JSON.stringify({ reply: accept ? 'once' : 'reject' }) },
      'permission.reply',
    )
  }

  async replyQuestion(requestId: string, answers: string[][]): Promise<void> {
    await this.call(
      `/question/${requestId}/reply`,
      { method: 'POST', body: JSON.stringify({ answers }) },
      'question.reply',
    )
  }

  async rejectQuestion(requestId: string): Promise<void> {
    await this.call(`/question/${requestId}/reject`, { method: 'POST' }, 'question.reject')
  }

  /**
   * Opens the global SSE stream. Resolves with an unsubscribe function once
   * the first event arrives (or the connection is established).
   */
  subscribeEvents(onEvent: (event: OpenEvent) => void, signal: AbortSignal): void {
    void (async () => {
      const response = await fetch(`${this.baseUrl}/event`, {
        headers: { Accept: 'text/event-stream' },
        signal,
      })
      if (!response.ok || !response.body) throw new Error(`event.subscribe failed (${response.status})`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          for (const line of frame.split('\n')) {
            const text = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
            if (!text) continue
            try {
              onEvent(JSON.parse(text) as OpenEvent)
            } catch {
              // ignore malformed frames
            }
          }
        }
      }
    })().catch((error: unknown) => {
      if (signal.aborted) return
      console.error(`opencode event stream dropped: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

export type OpenCodeServer = {
  client: OpenCodeClient
  version: string
  close: () => Promise<void>
}

/** Spawns `opencode serve` on a loopback port and waits for /global/health. */
export async function startOpenCodeServer(options?: { bin?: string }): Promise<OpenCodeServer> {
  const bin = options?.bin ?? 'opencode'
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(bin, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }) as unknown as ChildProcessWithoutNullStreams
  } catch (error) {
    throw new Error(
      `could not start opencode (is it installed? see https://opencode.ai): ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const failures: string[] = []
  child.on('error', (error) => {
    failures.push(error.message)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    const text = chunk.trim()
    if (text) console.error(`opencode: ${text}`)
  })

  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('opencode serve did not report a port in time')), 20_000)
    let output = ''
    const onData = (chunk: string) => {
      output += chunk
      const match = output.match(/opencode server listening on (https?:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve(match[1].replace(/\/$/, ''))
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`opencode serve exited (${code ?? 'signal'}): ${failures.join('; ') || 'see logs'}`))
    })
  })

  const client = new OpenCodeClient(baseUrl)
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const health = await client.health()
      return {
        client,
        version: health.version,
        close: async () => {
          if (!child.killed) child.kill('SIGTERM')
        },
      }
    } catch {
      if (Date.now() > deadline) {
        if (!child.killed) child.kill('SIGTERM')
        throw new Error('opencode serve did not become healthy in time')
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}
