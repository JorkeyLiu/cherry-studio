import { describe, expect, it, vi } from 'vitest'

const { calls } = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('../SqliteMessageDataSource', () => ({
  SqliteMessageDataSource: class {
    fetchWholeTopicSnapshot(...args: unknown[]) {
      calls.push(args)
      return Promise.resolve({ messages: [], blocks: [], snapshot: {} })
    }
  },
  ChatDbResultError: class extends Error {}
}))
vi.mock('@renderer/databases', () => ({ default: {} }))
vi.mock('../FileLock', () => ({ fileLock: { run: vi.fn() } }))

import { DbService } from '../DbService'

describe('DbService — fetchWholeTopicSnapshot projection pass-through', () => {
  it('forwards the typed projection to the ordinary source unchanged', async () => {
    const service = new DbService()
    calls.length = 0

    await service.fetchWholeTopicSnapshot('t1', null, 'conversation-navigation')
    await service.fetchWholeTopicSnapshot('t1', 'br1', 'full')
    await service.fetchWholeTopicSnapshot('t1', null)

    // The service is a typed pass-through: it neither drops nor invents the
    // projection, and the absent case stays a two-argument call.
    expect(calls[0]).toEqual(['t1', null, 'conversation-navigation'])
    expect(calls[1]).toEqual(['t1', 'br1', 'full'])
    // The absent case forwards `undefined` without inventing a projection value
    // (the wire request built downstream omits the key entirely).
    expect(calls[2]).toEqual(['t1', null, undefined])
  })

  it('throws when the ordinary source does not expose the read', () => {
    const service = new DbService()
    ;(service as unknown as { _ordinarySource: unknown })._ordinarySource = {}
    expect(() => service.fetchWholeTopicSnapshot('t1', null, 'conversation-navigation')).toThrow(
      'fetchWholeTopicSnapshot unavailable'
    )
  })
})
