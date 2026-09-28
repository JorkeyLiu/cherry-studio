import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }))
vi.mock('@renderer/store', () => ({ default: { dispatch: mockDispatch } }))
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((p: any) => ({ type: 'updateTopicUpdatedAt', payload: p }))
}))

import { ok } from '@shared/chatDb'

import { ChatDbResultError, SqliteMessageDataSource } from '../SqliteMessageDataSource'

describe('SqliteMessageDataSource.insertMessagesAfterAnchor — S6.2c-2', () => {
  let api: any
  let ds: SqliteMessageDataSource

  beforeEach(() => {
    vi.clearAllMocks()
    api = {
      insertMessagesAfterAnchor: vi.fn()
    }
    ds = new SqliteMessageDataSource(api)
  })

  it('calls api.insertMessagesAfterAnchor with stable anchor request (no insertIndex)', async () => {
    const mockResult = ok({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      topicId: 't-1',
      branchId: null,
      afterMessageId: 'm-anchor',
      insertedMessages: [
        { id: 'm-u1', topicId: 't-1', role: 'user', blocks: ['b-u1'] },
        { id: 'm-a1', topicId: 't-1', role: 'assistant', blocks: ['b-a1'] }
      ],
      insertedBlocks: [
        { id: 'b-u1', messageId: 'm-u1' },
        { id: 'b-a1', messageId: 'm-a1' }
      ],
      insertedMessageIds: ['m-u1', 'm-a1'],
      patchedMessageIds: [],
      beforeMessageId: 'm-anchor',
      nextMessageId: 'm-next',
      mutableMessageIds: ['m-u1', 'm-a1']
    })
    api.insertMessagesAfterAnchor.mockResolvedValue(mockResult)

    const entries = [
      {
        message: { id: 'm-u1', topicId: 't-1', role: 'user' } as any,
        blocks: [{ id: 'b-u1', messageId: 'm-u1' } as any]
      },
      {
        message: { id: 'm-a1', topicId: 't-1', role: 'assistant' } as any,
        blocks: [{ id: 'b-a1', messageId: 'm-a1' } as any]
      }
    ]
    const res = await ds.insertMessagesAfterAnchor('t-1', 'm-anchor', entries as any)

    expect(api.insertMessagesAfterAnchor).toHaveBeenCalledOnce()
    const req = api.insertMessagesAfterAnchor.mock.calls[0][0]
    expect(req.topicId).toBe('t-1')
    expect(req.afterMessageId).toBe('m-anchor')
    expect(req.entries).toHaveLength(2)
    expect(req.entries[0].message.id).toBe('m-u1')
    // No numeric insertIndex, sortOrder, branchPointIndex
    expect(req.insertIndex).toBeUndefined()
    expect(req.sortOrder).toBeUndefined()
    expect(req.branchPointIndex).toBeUndefined()
    expect(req.index).toBeUndefined()
    // Validate second entry
    expect(req.entries[1].message.id).toBe('m-a1')
    expect(mockDispatch).toHaveBeenCalledOnce()
    expect(res.affectedFileIds).toEqual([])
    // Authoritative placement + capability delta pass through untouched.
    expect(res.insertedMessageIds).toEqual(['m-u1', 'm-a1'])
    expect(res.beforeMessageId).toBe('m-anchor')
    expect(res.nextMessageId).toBe('m-next')
    expect(res.mutableMessageIds).toEqual(['m-u1', 'm-a1'])
  })

  it('throws ChatDbResultError on structured failure, propagates transport rejection', async () => {
    const fail = { ok: false as const, error: { code: 'NOT_FOUND', message: 'missing', retryable: false } }
    api.insertMessagesAfterAnchor.mockResolvedValue(fail as any)
    await expect(
      ds.insertMessagesAfterAnchor('t', 'anchor', [{ message: { id: 'm' } as any, blocks: [] }])
    ).rejects.toBeInstanceOf(ChatDbResultError)

    api.insertMessagesAfterAnchor.mockRejectedValue(new Error('transport'))
    await expect(
      ds.insertMessagesAfterAnchor('t', 'anchor', [{ message: { id: 'm' } as any, blocks: [] }])
    ).rejects.toThrow('transport')
  })

  it('dispatches updateTopicUpdatedAt exactly once on success, not on failure', async () => {
    api.insertMessagesAfterAnchor.mockResolvedValue(
      ok({
        affectedFileIds: [],
        remainingReferenceCounts: {},
        topicId: 't',
        branchId: null,
        afterMessageId: 'a',
        insertedMessages: [{ id: 'm' }],
        insertedBlocks: [],
        insertedMessageIds: ['m'],
        patchedMessageIds: [],
        beforeMessageId: 'a',
        nextMessageId: null,
        mutableMessageIds: ['m']
      })
    )
    await ds.insertMessagesAfterAnchor('t', 'a', [{ message: { id: 'm' } as any, blocks: [] }])
    expect(mockDispatch).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    api.insertMessagesAfterAnchor.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'x', retryable: false }
    } as any)
    await expect(
      ds.insertMessagesAfterAnchor('t', 'a', [{ message: { id: 'm' } as any, blocks: [] }])
    ).rejects.toThrow()
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('does not call legacy appendMessage or pasteMessagesToTopic', async () => {
    api.insertMessagesAfterAnchor.mockResolvedValue(
      ok({
        affectedFileIds: [],
        remainingReferenceCounts: {},
        topicId: 't',
        branchId: null,
        afterMessageId: 'a',
        insertedMessages: [{ id: 'm' }],
        insertedBlocks: [],
        insertedMessageIds: ['m'],
        patchedMessageIds: [],
        beforeMessageId: 'a',
        nextMessageId: null,
        mutableMessageIds: ['m']
      })
    )
    api.appendMessage = vi.fn()
    api.pasteMessagesToTopic = vi.fn()
    await ds.insertMessagesAfterAnchor('t', 'a', [{ message: { id: 'm' } as any, blocks: [] }])
    expect(api.appendMessage).not.toHaveBeenCalled()
    expect(api.pasteMessagesToTopic).not.toHaveBeenCalled()
  })

  it('preserves file-reference semantics (blocks with file carry through)', async () => {
    api.insertMessagesAfterAnchor.mockResolvedValue(
      ok({
        affectedFileIds: ['file-1'],
        remainingReferenceCounts: { 'file-1': 1 },
        topicId: 't',
        branchId: null,
        afterMessageId: 'anchor',
        insertedMessages: [{ id: 'm1', blocks: ['b1'] }],
        insertedBlocks: [{ id: 'b1', messageId: 'm1', file: { id: 'file-1' } }],
        insertedMessageIds: ['m1'],
        patchedMessageIds: [],
        beforeMessageId: 'anchor',
        nextMessageId: null,
        mutableMessageIds: ['m1']
      })
    )
    const entries = [
      { message: { id: 'm1' } as any, blocks: [{ id: 'b1', messageId: 'm1', file: { id: 'file-1' } } as any] }
    ]
    const res = await ds.insertMessagesAfterAnchor('t', 'anchor', entries)
    expect(api.insertMessagesAfterAnchor.mock.calls[0][0].entries[0].blocks[0].id).toBe('b1')
    expect(res.affectedFileIds).toEqual(['file-1'])
  })
})
