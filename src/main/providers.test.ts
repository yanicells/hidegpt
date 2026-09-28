import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptySnapshot } from '../codex/types'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
})

describe('streaming snapshot delivery', () => {
  it('batches token bursts and delivers the final answer without a stale update', async () => {
    vi.useFakeTimers()
    const providers = await import('./providers')
    const send = vi.fn()
    providers.initProviders({
      getWindow: () => ({ setTitle: vi.fn(), webContents: { send } }) as never,
      onChanged: vi.fn(),
    })
    const session = providers.getCodexSession()
    session.snapshot = {
      ...emptySnapshot(),
      status: 'ready',
      route: { kind: 'doc', threadId: 't' },
      streaming: true,
      blocks: [{ kind: 'agent', id: 'a', text: '' }],
    }
    providers.sendSnapshot()
    for (let i = 1; i <= 200; i++) {
      session.snapshot = { ...session.snapshot, blocks: [{ kind: 'agent', id: 'a', text: 'word '.repeat(i) }] }
      providers.sendSnapshot()
    }
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(32)
    expect(send).toHaveBeenCalledTimes(2)
    // Only the streaming block crosses IPC; the rest of the snapshot is unchanged.
    expect(send.mock.calls[1][1]).toEqual({
      fields: {},
      blocks: { length: 1, changed: [[0, { kind: 'agent', id: 'a', text: 'word '.repeat(200) }]] },
    })
    session.snapshot = { ...session.snapshot, blocks: [{ kind: 'agent', id: 'a', text: 'complete' }], streaming: false }
    providers.sendSnapshot()
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
      fields: { streaming: false },
      blocks: { changed: [[0, { text: 'complete' }]] },
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(send).toHaveBeenCalledTimes(3)
  })
})
