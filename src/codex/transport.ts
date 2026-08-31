import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import {
  LineBuffer,
  type Incoming,
  type JsonRpcId,
  decodeLine,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResponse,
} from './jsonrpc'

export type ServerRequestHandler = (request: {
  id: JsonRpcId
  method: string
  params: unknown
}) => void

export type NotificationHandler = (method: string, params: unknown) => void

export type CodexTransport = {
  request: <T>(method: string, params?: unknown) => Promise<T>
  notify: (method: string, params?: unknown) => void
  respond: (id: JsonRpcId, result: unknown) => void
  reject: (id: JsonRpcId, message: string) => void
  onNotification: (handler: NotificationHandler) => () => void
  onRequest: (handler: ServerRequestHandler) => () => void
  onDisconnect: (handler: () => void) => () => void
  close: () => Promise<void>
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export function createTransportFromStdio(options: {
  write: (chunk: string) => void
  subscribe: (onChunk: (chunk: string) => void) => () => void
  close: () => Promise<void>
}): CodexTransport {
  let nextId = 1
  const pending = new Map<JsonRpcId, Pending>()
  const notifications = new Set<NotificationHandler>()
  const requests = new Set<ServerRequestHandler>()
  const disconnects = new Set<() => void>()
  const buffer = new LineBuffer()
  let closed = false

  const failAll = (error: Error) => {
    if (closed) return
    closed = true
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
    for (const handler of disconnects) handler()
  }

  const unsubscribe = options.subscribe((chunk) => {
    for (const line of buffer.push(chunk)) {
      let incoming: Incoming | null = null
      try {
        incoming = decodeLine(line)
      } catch (error) {
        console.error('codex: bad json line', line, error)
        continue
      }
      if (!incoming) continue
      if (incoming.kind === 'response') {
        const waiter = pending.get(incoming.id)
        if (!waiter) continue
        pending.delete(incoming.id)
        waiter.resolve(incoming.result)
      } else if (incoming.kind === 'error') {
        const waiter = pending.get(incoming.id)
        if (!waiter) continue
        pending.delete(incoming.id)
        waiter.reject(new Error(incoming.message))
      } else if (incoming.kind === 'request') {
        for (const handler of requests) handler(incoming)
      } else {
        for (const handler of notifications) handler(incoming.method, incoming.params)
      }
    }
  })

  return {
    request<T>(method: string, params?: unknown) {
      if (closed) return Promise.reject(new Error('transport closed'))
      const id = nextId
      nextId += 1
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject })
        options.write(encodeRequest(id, method, params))
      })
    },
    notify(method, params) {
      options.write(encodeNotification(method, params))
    },
    respond(id, result) {
      options.write(encodeResponse(id, result))
    },
    reject(id, message) {
      options.write(encodeError(id, -32000, message))
    },
    onNotification(handler) {
      notifications.add(handler)
      return () => notifications.delete(handler)
    },
    onRequest(handler) {
      requests.add(handler)
      return () => requests.delete(handler)
    },
    onDisconnect(handler) {
      disconnects.add(handler)
      return () => disconnects.delete(handler)
    },
    async close() {
      failAll(new Error('transport closed'))
      unsubscribe()
      await options.close()
    },
  }
}

export function spawnCodexAppServer(options?: { bin?: string }): CodexTransport {
  const bin = options?.bin ?? 'codex'
  const child: ChildProcessWithoutNullStreams = spawn(bin, ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    const text = chunk.trim()
    if (!text) return
    if (/failed to refresh OAuth tokens/i.test(text) && /invalid_grant/i.test(text)) return
    console.error(text)
  })

  const transport = createTransportFromStdio({
    write(chunk) {
      child.stdin.write(chunk)
    },
    subscribe(onChunk) {
      child.stdout.setEncoding('utf8')
      const onData = (chunk: string) => onChunk(chunk)
      child.stdout.on('data', onData)
      return () => child.stdout.off('data', onData)
    },
    async close() {
      if (!child.killed) child.kill('SIGTERM')
    },
  })
  child.on('error', () => {
    void transport.close()
  })
  child.on('exit', () => {
    void transport.close()
  })
  return transport
}
