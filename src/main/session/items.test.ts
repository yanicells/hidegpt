import { describe, expect, it } from 'vitest'

import type { AssistantItem, Item, RequestItem, UserItem } from '../../provider/events'
import { appendDelta, clearRetrying, expireRequests, upsertItem } from './items'

const user = (id: string, text: string): UserItem => ({ kind: 'user', id, text })
const assistant = (id: string, text: string): AssistantItem => ({ kind: 'assistant', id, text, phase: 'final' })
const request = (status: RequestItem['status']): RequestItem => ({
  kind: 'request',
  id: 'ap_1',
  request: 'command',
  status,
  subject: 'ls',
  detail: '',
  fields: [],
  questions: [],
})

describe('items', () => {
  it('replaces the optimistic echo with the server’s message, by client id or by text', () => {
    const items: Item[] = [user('local-1', 'Hi'), user('local-2', 'Again')]
    expect(upsertItem(items, user('u1', 'Hi'), 'local-1').map((item) => item.id)).toEqual(['u1', 'local-2'])
    expect(upsertItem(items, user('u2', 'Again')).map((item) => item.id)).toEqual(['local-1', 'u2'])
  })

  it('never moves a request back from what the person did, or out of a final status', () => {
    expect(upsertItem([request('sending')], request('pending'))[0]).toMatchObject({ status: 'sending' })
    expect(upsertItem([request('declined')], request('expired'))[0]).toMatchObject({ status: 'declined' })
    expect(upsertItem([request('pending')], request('accepted'))[0]).toMatchObject({ status: 'accepted' })
  })

  it('grows a streamed item, starting it from `create` when it is new, and touches nothing else', () => {
    const items: Item[] = [user('u1', 'Hi'), assistant('a1', 'Hel')]
    const grown = appendDelta(items, 'a1', 'lo')
    expect(grown[1]).toMatchObject({ text: 'Hello' })
    expect(grown[0]).toBe(items[0])
    expect(appendDelta(items, 'a2', 'x')).toBe(items)
    expect(appendDelta(items, 'a2', 'x', assistant('a2', '')).at(-1)).toMatchObject({ id: 'a2', text: 'x' })
  })

  it('drops the current turn’s retrying notice, and returns the same list when there is none', () => {
    const retrying: Item = { kind: 'notice', id: 'n1', notice: 'retrying', detail: null }
    expect(clearRetrying([user('u1', 'Hi'), retrying, assistant('a1', 'Hel')]).map((item) => item.id)).toEqual([
      'u1',
      'a1',
    ])
    const clean: Item[] = [retrying, user('u2', 'Again'), assistant('a2', 'Hi')]
    expect(clearRetrying(clean)).toBe(clean)
  })

  it('expires open requests on a turn’s end, and returns the same list when there are none', () => {
    expect(expireRequests([request('sending')])[0]).toMatchObject({ status: 'expired' })
    const settled: Item[] = [request('accepted')]
    expect(expireRequests(settled)).toBe(settled)
  })
})
