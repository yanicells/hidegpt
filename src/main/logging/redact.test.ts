import { describe, expect, it } from 'vitest'
import { capCause, MAX_CAUSE_BYTES, makeRedactor } from './redact'

describe('makeRedactor', () => {
  const redact = makeRedactor({ home: '/Users/alice', username: 'alice' })

  it('removes credentials in URL queries, headers and JSON', () => {
    expect(redact('GET https://x.example/cb?code=4/0Ab&state=xyz&page=2')).toBe(
      'GET https://x.example/cb?code=<redacted>&state=<redacted>&page=2',
    )
    expect(redact('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic <redacted>')
    expect(redact('{"password": "hunter2"}')).toBe('{"password": "<redacted>"}')
    expect(redact('retry with api_key=abc123')).toBe('retry with api_key=<redacted>')
  })

  it('removes emails, including one made of the account name', () => {
    expect(redact('sent to bob.lee+docs@mail.example.org, cc alice@example.com')).toBe('sent to <email>, cc <email>')
  })

  it('takes linear time on a long message', () => {
    // 30 KB with no address or key: about a millisecond. A pattern retried from each character took
    // seconds per 10 KB; measured rather than left to hang, since a running regex cannot be stopped.
    const text = `${'x'.repeat(30_000)} ${'a.b-'.repeat(1_000)}`
    const start = performance.now()
    expect(redact(text)).toBe(text)
    expect(performance.now() - start).toBeLessThan(250)
  })

  it('removes addresses with non-ASCII letters', () => {
    expect(redact('from jösé@exämple.com and 用户@例子.中国')).toBe('from <email> and <email>')
  })

  it('keeps ordinary text that only looks like a key', () => {
    for (const text of [
      'Process exited with code=1',
      'errno=-2 code=ENOENT syscall=spawn',
      'Basic setup failed',
      'Basic configuration error',
      'Bearer token missing',
    ]) {
      expect(redact(text)).toBe(text)
    }
  })

  it('removes the home folder only as a whole folder', () => {
    expect(redact("open '/Users/alice/x.png'")).toBe("open '~/x.png'")
    expect(redact('cwd /Users/alice')).toBe('cwd ~')
    expect(redact('at (/Users/alice:1:2)')).toBe('at (~:1:2)')
    expect(redact('/Users/alicebob/x')).toBe('/Users/alicebob/x')
  })

  it('leaves paths alone when the account name is a common path word', () => {
    const admin = makeRedactor({ home: '/Users/admin', username: 'admin' })
    expect(admin('at src/admin/x.ts in /Users/admin/app')).toBe('at src/admin/x.ts in ~/app')
    const main = makeRedactor({ home: '/home/main', username: 'main' })
    expect(main('/Applications/Docs.app/Contents/Resources/app.asar/out/main/index.js')).toBe(
      '/Applications/Docs.app/Contents/Resources/app.asar/out/main/index.js',
    )
  })
})

describe('capCause', () => {
  it('keeps short text and cuts long text on a character boundary', () => {
    expect(capCause('short')).toBe('short')
    // Three-byte characters: the limit falls inside one.
    const cut = capCause('€'.repeat(MAX_CAUSE_BYTES))
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(MAX_CAUSE_BYTES)
    expect(cut).toMatch(/^€+\n… \(cut\)$/)
  })
})
