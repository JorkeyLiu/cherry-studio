import type { BranchMessagesToTopicRequest } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }))
vi.mock('@renderer/store', () => ({ default: { dispatch: mockDispatch } }))
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((p: any) => ({ type: 'updateTopicUpdatedAt', payload: p }))
}))

import { ok } from '@shared/chatDb'

import { ChatDbResultError, SqliteMessageDataSource } from '../SqliteMessageDataSource'

describe('SqliteMessageDataSource.branchMessagesToTopic — S6.2c-1', () => {
  let api: any
  let ds: SqliteMessageDataSource

  beforeEach(() => {
    vi.clearAllMocks()
    api = {
      branchMessagesToTopic: vi.fn()
    }
    ds = new SqliteMessageDataSource(api)
  })

  it('calls api.branchMessagesToTopic with stable anchor request (no index)', async () => {
    const mockResult = ok({ messages: [{ id: 'm1', blocks: ['b1'] }], blocks: [{ id: 'b1', messageId: 'm1' }] })
    api.branchMessagesToTopic.mockResolvedValue(mockResult)

    const res = await ds.branchMessagesToTopic('src-1', 'dst-1', 'm-anchor', 'assistant-1')

    expect(api.branchMessagesToTopic).toHaveBeenCalledOnce()
    const req: BranchMessagesToTopicRequest = api.branchMessagesToTopic.mock.calls[0][0]
    expect(req.sourceTopicId).toBe('src-1')
    expect(req.targetTopicId).toBe('dst-1')
    expect(req.anchorMessageId).toBe('m-anchor')
    expect(req.assistantId).toBe('assistant-1')
    // No numeric index field
    expect((req as any).branchPointIndex).toBeUndefined()
    expect((req as any).sortOrder).toBeUndefined()
    expect((req as any).targetTopicId).toBeDefined()
    // Validate no extra keys beyond allowed set? datasource clones via cloneForWire which strips undefined but keeps defined.
    // Dispatch called once for target
    expect(mockDispatch).toHaveBeenCalledOnce()
    // Returns wire projection
    expect(res.messages.length).toBe(1)
    expect(res.blocks.length).toBe(1)
  })

  it('throws ChatDbResultError on structured failure, propagates transport rejection', async () => {
    const fail = { ok: false as const, error: { code: 'NOT_FOUND', message: 'missing', retryable: false } }
    api.branchMessagesToTopic.mockResolvedValue(fail as any)
    await expect(ds.branchMessagesToTopic('src', 'dst', 'anchor')).rejects.toBeInstanceOf(ChatDbResultError)

    api.branchMessagesToTopic.mockRejectedValue(new Error('transport'))
    await expect(ds.branchMessagesToTopic('src', 'dst', 'anchor')).rejects.toThrow('transport')
  })

  it('dispatches updateTopicUpdatedAt exactly once for target on success, not on failure', async () => {
    api.branchMessagesToTopic.mockResolvedValue(ok({ messages: [], blocks: [] }))
    await ds.branchMessagesToTopic('s', 't', 'a')
    expect(mockDispatch).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    api.branchMessagesToTopic.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'x', retryable: false }
    } as any)
    await expect(ds.branchMessagesToTopic('s', 't', 'a')).rejects.toThrow()
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('does not call any other api method', async () => {
    api.branchMessagesToTopic.mockResolvedValue(ok({ messages: [], blocks: [] }))
    api.cloneMessagesToTopic = vi.fn()
    await ds.branchMessagesToTopic('s', 't', 'a')
    expect(api.cloneMessagesToTopic).not.toHaveBeenCalled()
  })
})
