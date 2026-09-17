import { describe, expect, it, vi } from 'vitest'

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }))
vi.mock('@renderer/store', () => ({ default: { dispatch: mockDispatch } }))
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((p: any) => ({ type: 'assistants/updateTopicUpdatedAt', payload: p }))
}))

import { ChatDbResultError, SqliteMessageDataSource } from '../SqliteMessageDataSource'

describe('SqliteMessageDataSource — fetchClipboardGroups', () => {
  it('unwraps success and returns groups without dispatch', async () => {
    const api = {
      fetchClipboardGroups: vi.fn(async () => ({
        ok: true,
        value: {
          messages: [{ id: 'u1', blocks: ['b1'] }],
          blocks: [{ id: 'b1', messageId: 'u1' }],
          groups: [{ groupId: 'u1', messageIds: ['u1'], positionIndex: 0 }],
          clipboard: {
            completeness: 'clipboard-groups',
            topicId: 't1',
            requestedCount: 1,
            returnedCount: 1,
            returnedMessageCount: 1,
            firstMessageId: 'u1',
            lastMessageId: 'u1'
          }
        }
      }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    const res = await ds.fetchClipboardGroups({ topicId: 't1', groupIds: ['u1'] })
    expect(api.fetchClipboardGroups).toHaveBeenCalledOnce()
    expect(api.fetchClipboardGroups).toHaveBeenCalledWith({ topicId: 't1', groupIds: ['u1'] })
    expect(res.groups).toEqual([{ groupId: 'u1', messageIds: ['u1'], positionIndex: 0 }])
    expect(res.clipboard.returnedCount).toBe(1)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('throws ChatDbResultError on NOT_FOUND without dispatch', async () => {
    const api = {
      fetchClipboardGroups: vi.fn(async () => ({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Topic t-missing does not exist', retryable: false }
      }))
    } as any
    const ds = new SqliteMessageDataSource(api)
    mockDispatch.mockClear()
    await expect(ds.fetchClipboardGroups({ topicId: 't-missing', groupIds: ['u1'] })).rejects.toBeInstanceOf(
      ChatDbResultError
    )
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('propagates transport rejection unchanged', async () => {
    const api = {
      fetchClipboardGroups: vi.fn(async () => {
        throw new Error('transport fail')
      })
    } as any
    const ds = new SqliteMessageDataSource(api)
    await expect(ds.fetchClipboardGroups({ topicId: 't1', groupIds: ['u1'] })).rejects.toThrow('transport fail')
  })

  it('throws when bridge method is not exposed', async () => {
    const ds = new SqliteMessageDataSource({} as any)
    await expect(ds.fetchClipboardGroups({ topicId: 't1', groupIds: ['u1'] })).rejects.toThrow(
      'ChatDb API unavailable: clipboard-groups read not exposed'
    )
  })
})
