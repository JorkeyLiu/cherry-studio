import { describe, expect, it, vi } from 'vitest'

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }))
vi.mock('@renderer/store', () => ({ default: { dispatch: mockDispatch } }))
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((p: any) => ({ type: 'assistants/updateTopicUpdatedAt', payload: p }))
}))

import { ChatDbResultError, SqliteMessageDataSource } from '../SqliteMessageDataSource'

describe('SqliteMessageDataSource — fetchWholeTopicSnapshot', () => {
  it('unwraps success and returns domain messages/blocks/snapshot without dispatch', async () => {
    const snapshotMeta = {
      completeness: 'whole-topic' as const,
      topicId: 't1',
      firstMessageId: 'm1',
      lastMessageId: 'm3',
      returnedCount: 3
    }
    const api = {
      fetchWholeTopicSnapshot: vi.fn(async () => ({
        ok: true,
        value: {
          messages: [
            { id: 'm1', blocks: ['b1'] },
            { id: 'm2', blocks: [] },
            { id: 'm3', blocks: ['b2'] }
          ],
          blocks: [
            { id: 'b1', messageId: 'm1' },
            { id: 'b2', messageId: 'm3' }
          ],
          snapshot: snapshotMeta
        }
      }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    const res = await ds.fetchWholeTopicSnapshot('t1')
    expect(api.fetchWholeTopicSnapshot).toHaveBeenCalledOnce()
    expect(api.fetchWholeTopicSnapshot).toHaveBeenCalledWith({ topicId: 't1', branchId: null })
    expect(res.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(res.blocks.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(res.snapshot).toEqual(snapshotMeta)
    // Explicit no dispatch: snapshot is caller-local only
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('maps wire null boundaries for empty topic without dispatch', async () => {
    const api = {
      fetchWholeTopicSnapshot: vi.fn(async () => ({
        ok: true,
        value: {
          messages: [],
          blocks: [],
          snapshot: {
            completeness: 'whole-topic',
            topicId: 't-empty',
            firstMessageId: null,
            lastMessageId: null,
            returnedCount: 0
          }
        }
      }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    const res = await ds.fetchWholeTopicSnapshot('t-empty')
    expect(res.messages).toEqual([])
    expect(res.snapshot.returnedCount).toBe(0)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('throws ChatDbResultError on NOT_FOUND without dispatch', async () => {
    const api = {
      fetchWholeTopicSnapshot: vi.fn(async () => ({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Topic t-missing does not exist', retryable: false }
      }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    await expect(ds.fetchWholeTopicSnapshot('t-missing')).rejects.toBeInstanceOf(ChatDbResultError)
    await expect(ds.fetchWholeTopicSnapshot('t-missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('propagates transport rejection unchanged', async () => {
    const api = {
      fetchWholeTopicSnapshot: vi.fn(async () => {
        throw new Error('transport fail')
      })
    } as any
    const ds = new SqliteMessageDataSource(api)
    await expect(ds.fetchWholeTopicSnapshot('t1')).rejects.toThrow('transport fail')
  })

  it('throws when bridge method is not exposed', async () => {
    const ds = new SqliteMessageDataSource({} as any)
    await expect(ds.fetchWholeTopicSnapshot('t1')).rejects.toThrow(
      'ChatDb API unavailable: whole-topic snapshot read not exposed'
    )
  })
})
