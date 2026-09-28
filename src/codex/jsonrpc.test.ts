import { describe, expect, it } from 'vitest'

import {
  LineBuffer,
  decodeLine,
  encodeNotification,
  encodeRequest,
  encodeResponse,
} from './jsonrpc'

describe('jsonrpc framing', () => {
  it('omits the jsonrpc field', () => {
    expect(encodeRequest(1, 'initialize', { clientInfo: { name: 'hidegpt' } })).toBe(
      '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"hidegpt"}}}\n',
    )
    expect(encodeNotification('initialized')).toBe('{"method":"initialized"}\n')
    expect(encodeResponse(1, { ok: true })).toBe('{"id":1,"result":{"ok":true}}\n')
  })

  it('decodes responses, server requests, and notifications', () => {
    expect(decodeLine('{"id":1,"result":{"threadId":"t1"}}')).toEqual({
      kind: 'response',
      id: 1,
      result: { threadId: 't1' },
    })
    expect(
      decodeLine(
        '{"id":7,"method":"item/commandExecution/requestApproval","params":{"command":"ls"}}',
      ),
    ).toEqual({
      kind: 'request',
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'ls' },
    })
    expect(decodeLine('{"method":"item/agentMessage/delta","params":{"delta":"Hi"}}')).toEqual({
      kind: 'notification',
      method: 'item/agentMessage/delta',
      params: { delta: 'Hi' },
    })
    expect(decodeLine('{"id":3,"error":{"code":-32600,"message":"nope"}}')).toEqual({
      kind: 'error',
      id: 3,
      code: -32600,
      message: 'nope',
      data: undefined,
    })
  })

  it('splits newline-delimited chunks', () => {
    const buffer = new LineBuffer()
    expect(buffer.push('{"id":1')).toEqual([])
    expect(buffer.push(',"result":1}\n{"method":"x"}\nleftover')).toEqual([
      '{"id":1,"result":1}',
      '{"method":"x"}',
    ])
  })

  it('throws on invalid JSON lines', () => {
    expect(() => decodeLine('not json')).toThrow()
    expect(() => decodeLine('{oops')).toThrow()
  })

  it('skips empty and whitespace lines', () => {
    expect(decodeLine('')).toBeNull()
    expect(decodeLine('   ')).toBeNull()
    expect(decodeLine('\n')).toBeNull()
    expect(decodeLine('\t  \n')).toBeNull()
  })

  it('decodes CRLF line endings', () => {
    expect(decodeLine('{"method":"x"}\r')).toEqual({ kind: 'notification', method: 'x', params: undefined })
    expect(decodeLine('{"method":"x"}\r\n')).toEqual({ kind: 'notification', method: 'x', params: undefined })
    const buffer = new LineBuffer()
    expect(buffer.push('{"method":"x"}\r\n{"id":1,"result":1}\r\n')).toEqual([
      '{"method":"x"}\r',
      '{"id":1,"result":1}\r',
    ])
    for (const line of buffer.push('leftover')) {
      expect(decodeLine(line)).toBeNull()
    }
  })

  it('round-trips string ids', () => {
    const request = encodeRequest('abc-123', 'initialize', { clientInfo: { name: 'hidegpt' } })
    expect(decodeLine(request.trim())).toEqual({
      kind: 'request',
      id: 'abc-123',
      method: 'initialize',
      params: { clientInfo: { name: 'hidegpt' } },
    })
    const response = encodeResponse('req-1', { ok: true })
    expect(decodeLine(response.trim())).toEqual({ kind: 'response', id: 'req-1', result: { ok: true } })
  })

  it('splits across pushes and flushes trailing newlines', () => {
    const split = new LineBuffer()
    expect(split.push('{"id":1')).toEqual([])
    expect(split.push(',"result":1}\n')).toEqual(['{"id":1,"result":1}'])
    expect(split.push('{"method":"y"}\n')).toEqual(['{"method":"y"}'])

    const trailing = new LineBuffer()
    expect(trailing.push('leftover')).toEqual([])
    expect(trailing.push('\n')).toEqual(['leftover'])
    expect(trailing.push('\n')).toEqual([''])

    const multi = new LineBuffer()
    expect(multi.push('a\nb\nc')).toEqual(['a', 'b'])
    expect(multi.push('\n')).toEqual(['c'])
  })
})
