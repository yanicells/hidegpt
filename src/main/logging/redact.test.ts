import { describe, expect, it } from 'vitest'
import { makeRedactor } from './redact'

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
