import { describe, expect, it } from 'vitest'

import { classify } from './failure'

describe('classify', () => {
  it.each([
    [{ message: 'boom', httpStatus: 429 }, 'usage_limit', false],
    [{ message: 'You have hit your usage limit.' }, 'usage_limit', false],
    [{ message: 'nope', httpStatus: 401 }, 'auth', false],
    [{ message: 'Not logged in' }, 'auth', false],
    [{ message: 'Please sign in again' }, 'auth', false],
    [
      {
        message:
          'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
      },
      'auth',
      false,
    ],
    [{ message: 'Error while assigning input' }, 'unknown', null],
    [{ message: 'design input rejected' }, 'unknown', null],
    [{ message: 'read ECONNRESET' }, 'transport_error', true],
    [{ message: 'bad', httpStatus: 422 }, 'validation_error', false],
    [{ message: 'Overloaded' }, 'provider_error', true],
    [{ message: 'oops', httpStatus: 503 }, 'provider_error', true],
    [{ message: 'Something odd' }, 'unknown', null],
  ] as const)('%o is %s', (error, failureClass, retryable) => {
    expect(classify(error)).toMatchObject({ class: failureClass, retryable })
  })

  it('checks the code before the message, and keeps resetAt only for a usage limit', () => {
    expect(classify({ message: 'Request failed', code: 'usage_limit_exceeded', resetAt: 1_700 })).toMatchObject({
      class: 'usage_limit',
      resetAt: 1_700,
    })
    expect(classify({ message: 'Overloaded', resetAt: 1_700 }).resetAt).toBeNull()
    expect(classify({ message: 'rate limit', resetAt: Number.NaN }).resetAt).toBeNull()
  })

  it('redacts secrets and bounds the detail', () => {
    const detail = classify({
      message: 'GET https://user:pw@api.example/v1?key=abc failed: Bearer sk-abcdefghijklmnopqrstu api_key=xyz',
    }).detail
    expect(detail).toBe('GET https://api.example/v1 failed: Bearer [REDACTED] api_key=[REDACTED]')
    expect(classify({ message: 'x'.repeat(10_000) }).detail).toHaveLength(4_096)
  })
})
