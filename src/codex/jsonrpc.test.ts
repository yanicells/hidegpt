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
})
