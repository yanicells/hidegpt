import type {
  OpenAgent,
  OpenCodeClient,
  OpenEvent,
  OpenMessage,
  OpenMessagePart,
  OpenProject,
  OpenProviderModel,
  OpenSession,
} from './client'

export function stubSession(id: string, title: string, projectID = ''): OpenSession {
  return {
    id,
    title,
    directory: '/tmp',
    projectID,
    agent: 'build',
    model: { providerID: 'opencode', modelID: 'muse-spark' },    time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
  }
}

export function stubUserMessage(id: string, sessionID: string, text: string): OpenMessage {
  return {
    info: { id, sessionID, role: 'user', time: { created: 1 } },
    parts: [{ id: `prt-${id}`, sessionID, messageID: id, type: 'text', text }],
  }
}

export function stubAssistantMessage(
  id: string,
  sessionID: string,
  parts: OpenMessagePart[],
): OpenMessage {
  return {
    info: { id, sessionID, role: 'assistant', time: { created: 2 } },
    parts,
  }
}

export function textPart(sessionID: string, messageID: string, text: string): OpenMessagePart {
  return { id: `prt-${messageID}-text`, sessionID, messageID, type: 'text', text }
}

export function reasoningPart(sessionID: string, messageID: string): OpenMessagePart {
  return { id: `prt-${messageID}-reason`, sessionID, messageID, type: 'reasoning', text: 'hmm' }
}

export function toolPart(sessionID: string, messageID: string, tool = 'bash'): OpenMessagePart {
  return {
    id: `prt-${messageID}-tool`,
    sessionID,
    messageID,
    type: 'tool',
    tool,
    state: { status: 'completed', output: 'ok' },
  }
}

export type FakeOpenCodeClient = OpenCodeClient & {
  calls: Array<{ method: string; args: unknown[] }>
  emit: (event: OpenEvent) => void
}

export function createFakeOpenCodeClient(options?: {
  sessions?: OpenSession[]
  messages?: Record<string, OpenMessage[]>
  models?: OpenProviderModel[]
  agents?: OpenAgent[]
  projects?: OpenProject[]
  failPrompt?: boolean
}): FakeOpenCodeClient {
  const sessions = options?.sessions ?? [stubSession('ses_1', 'Essay'), stubSession('ses_2', 'Lab notes')]
  const messages =
    options?.messages ??
    ({
      ses_1: [
        stubUserMessage('msg_u1', 'ses_1', 'What is photosynthesis?'),
        stubAssistantMessage('msg_a1', 'ses_1', [
          reasoningPart('ses_1', 'msg_a1'),
          textPart('ses_1', 'msg_a1', 'Plants turn light into food.'),
          toolPart('ses_1', 'msg_a1'),
        ]),
      ],
      ses_2: [],
    } satisfies Record<string, OpenMessage[]>)
  const handlers = new Set<(event: OpenEvent) => void>()
  const calls: FakeOpenCodeClient['calls'] = []

  const client = {
    calls,
    emit: (event: OpenEvent) => {
      for (const handler of handlers) handler(event)
    },
    baseUrl: 'http://127.0.0.1:1',
    async health() {
      calls.push({ method: 'health', args: [] })
      return { healthy: true, version: 'fake' }
    },
    async listSessions(opts?: { search?: string }) {
      calls.push({ method: 'listSessions', args: [opts] })
      const search = opts?.search?.toLowerCase()
      return search ? sessions.filter((session) => session.title.toLowerCase().includes(search)) : sessions
    },
    async createSession(opts?: { title?: string }) {
      calls.push({ method: 'createSession', args: [opts] })
      const session = stubSession('ses_new', opts?.title ?? '')
      sessions.push(session)
      messages[session.id] = []
      return session
    },
    async deleteSession() {},
    async listMessages(sessionId: string) {
      calls.push({ method: 'listMessages', args: [sessionId] })
      return messages[sessionId] ?? []
    },
    async promptAsync(sessionId: string, opts: { text: string }) {
      calls.push({ method: 'promptAsync', args: [sessionId, opts] })
      if (options?.failPrompt) throw new Error('nope')
    },
    async abort() {},
    async listModels() {
      calls.push({ method: 'listModels', args: [] })
      return (
        options?.models ?? [
          { id: 'muse-spark', providerID: 'opencode', name: 'Muse Spark' },
          { id: 'gpt-5', providerID: 'openai', name: 'GPT-5' },
        ]
      )
    },
    async listProviders() {
      return []
    },
    async providerDefaults() {
      return {}
    },
    async listAgents() {
      calls.push({ method: 'listAgents', args: [] })
      return options?.agents ?? [{ name: 'build', mode: 'primary' }, { name: 'explore', mode: 'subagent' }, { name: 'plan', mode: 'primary' }]
    },
    async listProjects() {
      return options?.projects ?? []
    },
    async replyPermission(requestId: string, accept: boolean) {
      calls.push({ method: 'replyPermission', args: [requestId, accept] })
    },
    async replyQuestion(requestId: string, answers: string[][]) {
      calls.push({ method: 'replyQuestion', args: [requestId, answers] })
    },
    async rejectQuestion(requestId: string) {
      calls.push({ method: 'rejectQuestion', args: [requestId] })
    },
    subscribeEvents(handler: (event: OpenEvent) => void) {
      handlers.add(handler)
    },
  } as unknown as FakeOpenCodeClient
  return client
}

export function createFakeServer(client: FakeOpenCodeClient) {
  return {
    client,
    version: 'fake',
    close: async () => {},
  }
}
