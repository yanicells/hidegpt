export type JsonRpcId = number | string

export type Incoming =
  | { kind: 'response'; id: JsonRpcId; result: unknown }
  | { kind: 'error'; id: JsonRpcId; code: number; message: string; data?: unknown }
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }

export function encodeRequest(id: JsonRpcId, method: string, params?: unknown): string {
  const message: Record<string, unknown> = { id, method }
  if (params !== undefined) message.params = params
  return `${JSON.stringify(message)}\n`
}

export function encodeNotification(method: string, params?: unknown): string {
  const message: Record<string, unknown> = { method }
  if (params !== undefined) message.params = params
  return `${JSON.stringify(message)}\n`
}

export function encodeResponse(id: JsonRpcId, result: unknown): string {
  return `${JSON.stringify({ id, result })}\n`
}

export function encodeError(id: JsonRpcId, code: number, message: string): string {
  return `${JSON.stringify({ id, error: { code, message } })}\n`
}

export function decodeLine(line: string): Incoming | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const message = JSON.parse(trimmed) as Record<string, unknown>
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id != null
  if (hasId && typeof message.method === 'string') {
    return {
      kind: 'request',
      id: message.id as JsonRpcId,
      method: message.method,
      params: message.params,
    }
  }
  if (hasId && message.error && typeof message.error === 'object') {
    const error = message.error as { code?: number; message?: string; data?: unknown }
    return {
      kind: 'error',
      id: message.id as JsonRpcId,
      code: error.code ?? -1,
      message: error.message ?? 'error',
      data: error.data,
    }
  }
  if (hasId) {
    return { kind: 'response', id: message.id as JsonRpcId, result: message.result }
  }
  if (typeof message.method === 'string') {
    return { kind: 'notification', method: message.method, params: message.params }
  }
  return null
}

export class LineBuffer {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    while (true) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      lines.push(this.buffer.slice(0, index))
      this.buffer = this.buffer.slice(index + 1)
    }
    return lines
  }
}
