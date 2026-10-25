import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }))
vi.mock('@renderer/store', () => ({ default: { dispatch: mockDispatch } }))
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((p: any) => ({ type: 'updateTopicUpdatedAt', payload: p }))
}))

import { ok } from '@shared/chatDb'

import { ChatDbResultError, SqliteMessageDataSource } from '../SqliteMessageDataSource'

describe('SqliteMessageDataSource.createReferencedTopic', () => {
  let api: any
  let ds: SqliteMessageDataSource

  beforeEach(() => {
    vi.clearAllMocks()
    api = { createReferencedTopic: vi.fn() }
    ds = new SqliteMessageDataSource(api)
  })

  it('calls api.createReferencedTopic with source route + anchor and returns the live prefix', async () => {
    const mockResult = ok({
      topicId: 'dst-1',
      reference: {
        targetTopicId: 'dst-1',
        sourceTopicId: 'src-1',
        sourceBranchId: null,
        anchorMessageId: 'm-a',
        sourceName: 'Source',
        createdAt: 't',
        updatedAt: 't'
      },
      messages: [{ id: 'm-a', topicId: 'src-1', blocks: [] }],
      blocks: []
    })
    api.createReferencedTopic.mockResolvedValue(mockResult)

    const res = await ds.createReferencedTopic('src-1', null, 'dst-1', 'm-a', 'assistant-1', 'Target')

    expect(api.createReferencedTopic).toHaveBeenCalledOnce()
    const req = api.createReferencedTopic.mock.calls[0][0]
    expect(req.sourceTopicId).toBe('src-1')
    expect(req.branchId).toBe(null)
    expect(req.targetTopicId).toBe('dst-1')
    expect(req.anchorMessageId).toBe('m-a')
    expect(req.assistantId).toBe('assistant-1')
    expect(req.name).toBe('Target')
    expect(res.topicId).toBe('dst-1')
    expect(res.reference.sourceTopicId).toBe('src-1')
    expect(res.messages.length).toBe(1)
    // Dispatches topic-updated exactly once for the new target topic.
    expect(mockDispatch).toHaveBeenCalledOnce()
  })

  it('throws ChatDbResultError on structured failure and dispatches nothing', async () => {
    api.createReferencedTopic.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'x', retryable: false }
    } as any)
    await expect(ds.createReferencedTopic('src', null, 'dst', 'anchor')).rejects.toBeInstanceOf(ChatDbResultError)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('throws when the api method is unavailable', async () => {
    const bare = new SqliteMessageDataSource({} as any)
    await expect(bare.createReferencedTopic('src', null, 'dst', 'anchor')).rejects.toThrow(/not exposed/)
  })
})
