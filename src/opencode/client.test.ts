import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeClient } from './client'

const client = new OpenCodeClient('http://127.0.0.1:4096')
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('OpenCode HTTP contract', () => {
  it('loads and searches the global catalog instead of only the launch project', async () => {
    const fetcher = vi.fn(async () => new Response('[]'))
    vi.stubGlobal('fetch', fetcher)
    await client.listSessions({ search: 'course notes', limit: 100 })
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:4096/experimental/session?search=course+notes&limit=100',
      expect.anything(),
    )
  })

  it('scopes create, prompt, and history requests to the selected directory', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    // A fresh Response per request is required because bodies are consumed.
    fetcher.mockImplementation(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const directory = '/tmp/course notes'
    await client.createSession({ directory, title: 'Week 4' })
    await client.promptAsync('ses_1', { directory, parts: [{ type: 'text', text: 'hello' }] })
    await client.listMessages('ses_1', 100, directory)
    for (const [url] of fetcher.mock.calls) expect(new URL(url).searchParams.get('directory')).toBe(directory)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ title: 'Week 4' })
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ parts: [{ type: 'text', text: 'hello' }] })
  })

  it('keeps named project worktrees and omits the global project', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { id: 'course', name: 'Course notes', worktree: '/tmp/course' },
              { id: 'global', worktree: '/' },
            ]),
          ),
      ),
    )
    expect(await client.listProjects()).toEqual([{ id: 'course', name: 'Course notes', worktree: '/tmp/course' }])
  })

  it('unwraps global events across CRLF and partial network chunks', async () => {
    const controller = new AbortController()
    const received = vi.fn()
    const encoder = new TextEncoder()
    const event = { id: 'evt_1', type: 'session.idle', properties: { sessionID: 'ses_1' } }
    const frame = `data: ${JSON.stringify({ directory: '/tmp/course', payload: event })}\r\n\r\n`
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(encoder.encode(frame.slice(0, 30)))
                stream.enqueue(encoder.encode(frame.slice(30)))
              },
            }),
          ),
      ),
    )
    client.subscribeEvents((value) => {
      received(value)
      controller.abort()
    }, controller.signal)
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(event))
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:4096/global/event', expect.anything())
  })

  it('reconnects after a dropped stream and stops retrying when aborted', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const reconnected = vi.fn()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(stream) {
              stream.close()
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(new ReadableStream({ start() {} })))
    vi.stubGlobal('fetch', fetcher)
    client.subscribeEvents(() => {}, controller.signal, reconnected)
    await vi.advanceTimersByTimeAsync(500)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(reconnected).toHaveBeenCalledOnce()
    controller.abort()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
