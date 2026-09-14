import { describe, expect, it, vi } from 'vitest'

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }))
vi.mock('@renderer/store', () => ({ default: { dispatch: mockDispatch } }))
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((p: any) => ({ type: 'assistants/updateTopicUpdatedAt', payload: p }))
}))

import { ChatDbResultError, SqliteMessageDataSource } from '../SqliteMessageDataSource'

describe('SqliteMessageDataSource — bounded naming/activity reads', () => {
  it('fetchTopicNamingContext maps exact request and returns domain shapes without dispatch', async () => {
    const namingMeta = {
      completeness: 'naming-context' as const,
      topicId: 't1',
      firstMessageId: 'm1',
      lastMessageId: 'm2',
      returnedLatestCount: 2
    }
    const api = {
      fetchTopicNamingContext: vi.fn(async () => ({
        ok: true,
        value: {
          topic: { id: 't1', name: 'Topic', isNameManuallyEdited: false },
          messageCount: 2,
          firstMessage: { id: 'm1', blocks: ['b1'] },
          latestMessages: [
            { id: 'm1', blocks: ['b1'] },
            { id: 'm2', blocks: [] }
          ],
          blocks: [{ id: 'b1', messageId: 'm1' }],
          naming: namingMeta
        }
      }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    const res = await ds.fetchTopicNamingContext('t1')
    expect(api.fetchTopicNamingContext).toHaveBeenCalledOnce()
    expect(api.fetchTopicNamingContext).toHaveBeenCalledWith({ topicId: 't1' })
    expect(res.topic).toEqual({ id: 't1', name: 'Topic', isNameManuallyEdited: false })
    expect(res.messageCount).toBe(2)
    expect(res.firstMessage?.id).toBe('m1')
    expect(res.latestMessages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(res.blocks.map((b) => b.id)).toEqual(['b1'])
    expect(res.naming).toEqual(namingMeta)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('fetchTopicNamingContext throws NOT_FOUND without dispatch and propagates transport', async () => {
    const notFoundApi = {
      fetchTopicNamingContext: vi.fn(async () => ({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Topic missing does not exist', retryable: false }
      }))
    } as any
    const ds = new SqliteMessageDataSource(notFoundApi)
    mockDispatch.mockClear()
    await expect(ds.fetchTopicNamingContext('missing')).rejects.toBeInstanceOf(ChatDbResultError)
    await expect(ds.fetchTopicNamingContext('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockDispatch).not.toHaveBeenCalled()

    const transportApi = {
      fetchTopicNamingContext: vi.fn(async () => {
        throw new Error('transport fail')
      })
    } as any
    await expect(new SqliteMessageDataSource(transportApi).fetchTopicNamingContext('t1')).rejects.toThrow(
      'transport fail'
    )
  })

  it('fetchTopicNamingContext throws when bridge method is not exposed', async () => {
    const ds = new SqliteMessageDataSource({} as any)
    await expect(ds.fetchTopicNamingContext('t1')).rejects.toThrow(
      'ChatDb API unavailable: naming-context read not exposed'
    )
  })

  it('fetchTopicActivity maps exact request and returns value without dispatch', async () => {
    const api = {
      fetchTopicActivity: vi.fn(async () => ({
        ok: true,
        value: {
          messageCount: 3,
          latestMessageId: 'm3',
          latestMessageCreatedAt: '2026-09-01T00:00:03.000Z',
          activity: { completeness: 'topic-activity', topicId: 't1' }
        }
      }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    const res = await ds.fetchTopicActivity('t1')
    expect(api.fetchTopicActivity).toHaveBeenCalledOnce()
    expect(api.fetchTopicActivity).toHaveBeenCalledWith({ topicId: 't1' })
    expect(res.messageCount).toBe(3)
    expect(res.latestMessageId).toBe('m3')
    expect(res.latestMessageCreatedAt).toBe('2026-09-01T00:00:03.000Z')
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('fetchTopicActivity throws NOT_FOUND without dispatch and propagates transport', async () => {
    const notFoundApi = {
      fetchTopicActivity: vi.fn(async () => ({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Topic missing does not exist', retryable: false }
      }))
    } as any
    const ds = new SqliteMessageDataSource(notFoundApi)
    mockDispatch.mockClear()
    await expect(ds.fetchTopicActivity('missing')).rejects.toBeInstanceOf(ChatDbResultError)
    expect(mockDispatch).not.toHaveBeenCalled()
    const transportApi = {
      fetchTopicActivity: vi.fn(async () => {
        throw new Error('transport fail')
      })
    } as any
    await expect(new SqliteMessageDataSource(transportApi).fetchTopicActivity('t1')).rejects.toThrow('transport fail')
  })

  it('fetchTopicActivity throws when bridge method is not exposed', async () => {
    const ds = new SqliteMessageDataSource({} as any)
    await expect(ds.fetchTopicActivity('t1')).rejects.toThrow('ChatDb API unavailable: topic-activity read not exposed')
  })
})
