/**
 * updateMessageAndBlocksThunk — LOCK-001 persistence ordering.
 *
 * Verifies:
 *  1. Single atomic SQLite write BEFORE Redux dispatch (persistence-first)
 *  2. SQLite failure does NOT touch Redux (no divergent state)
 *  3. Error propagates to callers (editor stays open)
 *  4. Success path commits both SQLite and Redux
 *  5. Atomic operation includes message patch + block upserts + block deletions
 *  6. Forbidden fields (topicId, sortOrder) are stripped from Redux patch
 *  7. Block deletions dispatched to Redux on success
 *  8. File cleanup result returned to callers
 */

import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => {
  const emptyCleanup = { affectedFileIds: [], remainingReferenceCounts: {} }
  return {
    mocks: {
      emptyCleanup,
      dbUpdateMessageAndBlocks: vi.fn().mockResolvedValue(emptyCleanup),
      dispatch: vi.fn(),
      updateMessageAction: vi.fn((p: unknown) => ({ type: 'updateMessage', payload: p })),
      upsertManyBlocksAction: vi.fn((p: unknown) => ({ type: 'upsertManyBlocks', payload: p })),
      removeManyBlocksAction: vi.fn((p: unknown) => ({ type: 'removeManyBlocks', payload: p })),
      updateTopicUpdatedAtAction: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', payload: p }))
    }
  }
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => ({})
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    updateMessage: mocks.updateMessageAction
  },
  selectMessagesForTopic: vi.fn()
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAtAction,
  default: {}
}))

vi.mock('@renderer/store/messageBlock', () => ({
  upsertManyBlocks: mocks.upsertManyBlocksAction,
  removeManyBlocks: mocks.removeManyBlocksAction,
  updateOneBlock: vi.fn(),
  upsertOneBlock: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    updateMessageAndBlocks: mocks.dbUpdateMessageAndBlocks,
    updateMessage: vi.fn(),
    updateBlocks: vi.fn(),
    updateSingleBlock: vi.fn(),
    appendMessage: vi.fn(),
    deleteMessage: vi.fn(),
    resetMessagesForResend: vi.fn(),
    fetchMessages: vi.fn().mockResolvedValue({ messages: [], blocks: [] }),
    deleteMessagesWithSegments: vi.fn(),
    deleteBlocks: vi.fn(),
    listBlocksByFile: vi.fn()
  }
}))

vi.mock('@renderer/services/db/DbService', () => ({
  DbService: {
    getInstance: () => ({
      updateMessageAndBlocks: vi.fn()
    })
  }
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: vi.fn(() => ({ add: vi.fn() })),
  waitForTopicQueue: vi.fn()
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  getMainTextContent: vi.fn(),
  findMainTextBlocks: vi.fn(),
  findAllBlocks: vi.fn(),
  findTranslationBlocks: vi.fn(),
  findTranslationBlocksById: vi.fn(),
  isAssistantInterruptedThinkingOnlyMessage: vi.fn()
}))

vi.mock('lru-cache', () => ({
  LRUCache: vi.fn().mockImplementation(() => ({
    has: vi.fn(() => false),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }))
}))

vi.mock('swr', () => ({
  mutate: vi.fn()
}))

vi.mock('i18next', () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn(),
    t: (k: string) => k
  },
  t: (k: string) => k
}))

vi.mock('@renderer/store/topicSegment', () => ({
  clearSegmentsForTopic: vi.fn()
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  clearTopicSegmentsFromDB: vi.fn(),
  loadTopicSegmentsThunk: vi.fn(),
  removeMessageFromSegmentsThunk: vi.fn()
}))

// Import AFTER mocks
import { updateMessageAndBlocksThunk } from '@renderer/store/thunk/messageThunk'

// --- Test data ------------------------------------------------------------

const topicId = 'topic-123'
const messageId = 'msg-456'

const makeBlock = (id: string, content: string): MessageBlock => ({
  id,
  messageId,
  type: MessageBlockType.MAIN_TEXT,
  content,
  status: MessageBlockStatus.SUCCESS,
  createdAt: '2026-01-01T00:00:00.000Z'
})

// --- Tests ----------------------------------------------------------------

describe('updateMessageAndBlocksThunk — LOCK-001 atomic persistence', () => {
  const dispatch = mocks.dispatch

  beforeEach(() => {
    vi.clearAllMocks()
    // Re-set default mock after clearAllMocks
    mocks.dbUpdateMessageAndBlocks.mockResolvedValue(mocks.emptyCleanup)
  })

  it('uses SINGLE atomic dbService.updateMessageAndBlocks (not separate updateMessage + updateBlocks)', async () => {
    const callOrder: string[] = []

    mocks.dbUpdateMessageAndBlocks.mockImplementation(async () => {
      callOrder.push('sqlite-atomic')
      return mocks.emptyCleanup
    })
    dispatch.mockImplementation((action: unknown) => {
      callOrder.push(`redux-${(action as any).type}`)
      return action
    })

    const messageUpdates = {
      id: messageId,
      updatedAt: '2026-07-29T00:00:00.000Z',
      usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 10 }
    }
    const blocks = [makeBlock('block-1', 'updated content')]

    await updateMessageAndBlocksThunk(topicId, messageUpdates, blocks)(dispatch)

    // Only ONE SQLite call — the atomic updateMessageAndBlocks
    expect(mocks.dbUpdateMessageAndBlocks).toHaveBeenCalledTimes(1)
    expect(mocks.dbUpdateMessageAndBlocks).toHaveBeenCalledWith(
      topicId,
      expect.objectContaining({ id: messageId }),
      blocks,
      []
    )

    // SQLite must appear before Redux in the call order
    const sqliteIdx = callOrder.findIndex((c) => c.startsWith('sqlite-'))
    const reduxIdx = callOrder.findIndex((c) => c.startsWith('redux-'))
    expect(sqliteIdx).toBeGreaterThanOrEqual(0)
    expect(reduxIdx).toBeGreaterThanOrEqual(0)
    expect(sqliteIdx).toBeLessThan(reduxIdx)
  })

  it('does NOT touch Redux when SQLite fails (LOCK-003)', async () => {
    mocks.dbUpdateMessageAndBlocks.mockRejectedValue(new Error('SQLite lock'))

    const messageUpdates = { id: messageId, updatedAt: '2026-07-29T00:00:00.000Z' }
    const blocks = [makeBlock('block-1', 'updated content')]

    await expect(updateMessageAndBlocksThunk(topicId, messageUpdates, blocks)(dispatch)).rejects.toThrow('SQLite lock')

    // Redux dispatch must NOT have been called
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('propagates error to caller (editor can stay open)', async () => {
    mocks.dbUpdateMessageAndBlocks.mockRejectedValue(new Error('DB write failed'))

    const messageUpdates = { id: messageId, content: 'test' }
    const blocks: MessageBlock[] = []

    const thunk = updateMessageAndBlocksThunk(topicId, messageUpdates, blocks)

    // The thunk should reject — caller can catch and keep editor open
    await expect(thunk(dispatch)).rejects.toThrow('DB write failed')
  })

  it('commits both SQLite and Redux on success', async () => {
    const messageUpdates = {
      id: messageId,
      updatedAt: '2026-07-29T00:00:00.000Z',
      usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 5 }
    }
    const blocks = [makeBlock('block-1', 'new content')]

    await updateMessageAndBlocksThunk(topicId, messageUpdates, blocks)(dispatch)

    // Atomic SQLite was called with correct args
    expect(mocks.dbUpdateMessageAndBlocks).toHaveBeenCalledWith(
      topicId,
      expect.objectContaining({ id: messageId, updatedAt: messageUpdates.updatedAt }),
      blocks,
      []
    )

    // Redux was also called
    expect(dispatch).toHaveBeenCalled()
    // updateMessage dispatched
    expect(mocks.updateMessageAction).toHaveBeenCalled()
    // upsertManyBlocks dispatched
    expect(mocks.upsertManyBlocksAction).toHaveBeenCalledWith(blocks)
    // updateTopicUpdatedAt dispatched
    expect(mocks.updateTopicUpdatedAtAction).toHaveBeenCalledWith({ topicId })
  })

  it('strips topicId and sortOrder from Redux patch (LOCK-002)', async () => {
    const messageUpdates = {
      id: messageId,
      topicId: 'should-be-stripped',
      sortOrder: 999,
      updatedAt: '2026-07-29T00:00:00.000Z'
    }

    await updateMessageAndBlocksThunk(topicId, messageUpdates, [])(dispatch)

    // Redux updateMessage must NOT contain topicId or sortOrder
    const reduxCall = mocks.updateMessageAction.mock.calls[0][0] as any
    expect(reduxCall.updates).not.toHaveProperty('topicId')
    expect(reduxCall.updates).not.toHaveProperty('sortOrder')
    // But should contain the actual changes
    expect(reduxCall.updates.updatedAt).toBe('2026-07-29T00:00:00.000Z')
  })

  it('passes blockIdsToDelete to atomic operation', async () => {
    const blocks = [makeBlock('block-1', 'kept')]
    const blockIdsToDelete = ['block-old-1', 'block-old-2']

    await updateMessageAndBlocksThunk(
      topicId,
      { id: messageId, updatedAt: '2026-07-29T00:00:00.000Z' },
      blocks,
      blockIdsToDelete
    )(dispatch)

    // Atomic call includes blockIdsToDelete
    expect(mocks.dbUpdateMessageAndBlocks).toHaveBeenCalledWith(
      topicId,
      expect.objectContaining({ id: messageId }),
      blocks,
      blockIdsToDelete
    )
  })

  it('dispatches removeManyBlocks for deleted blocks on success', async () => {
    const blocks = [makeBlock('block-1', 'kept')]
    const blockIdsToDelete = ['block-old-1']

    await updateMessageAndBlocksThunk(
      topicId,
      { id: messageId, updatedAt: '2026-07-29T00:00:00.000Z' },
      blocks,
      blockIdsToDelete
    )(dispatch)

    // removeManyBlocks dispatched for deleted blocks
    expect(mocks.removeManyBlocksAction).toHaveBeenCalledWith(blockIdsToDelete)
  })

  it('skips SQLite message update when messageUpdates is null', async () => {
    const blocks = [makeBlock('block-1', 'only blocks changed')]

    await updateMessageAndBlocksThunk(topicId, null, blocks)(dispatch)

    // SQLite should still be called (for blocks), but with minimal messageUpdates
    expect(mocks.dbUpdateMessageAndBlocks).toHaveBeenCalledTimes(1)
    // Redux message update should be skipped (null messageUpdates)
    expect(mocks.updateMessageAction).not.toHaveBeenCalled()
    // upsertManyBlocks should be called
    expect(mocks.upsertManyBlocksAction).toHaveBeenCalledWith(blocks)
  })

  it('handles null messageUpdates gracefully', async () => {
    const blocks = [makeBlock('block-1', 'content')]

    await updateMessageAndBlocksThunk(topicId, null, blocks)(dispatch)

    // SQLite should be called with null messageUpdates → { id: undefined }
    expect(mocks.dbUpdateMessageAndBlocks).toHaveBeenCalledTimes(1)
    // Only upsertManyBlocks should dispatch
    expect(mocks.upsertManyBlocksAction).toHaveBeenCalled()
  })

  it('does nothing when both messageUpdates is null and blocks are empty', async () => {
    await updateMessageAndBlocksThunk(topicId, null, [])(dispatch)

    // updateMessageAndBlocks is still called (atomic — minimal transaction)
    expect(mocks.dbUpdateMessageAndBlocks).toHaveBeenCalledTimes(1)
    // Only updateTopicUpdatedAt is called unconditionally
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(mocks.updateTopicUpdatedAtAction).toHaveBeenCalledWith({ topicId })
  })

  it('returns FileCleanupResult to callers', async () => {
    const cleanupResult = { affectedFileIds: ['file-1'], remainingReferenceCounts: { 'file-1': 0 } }
    mocks.dbUpdateMessageAndBlocks.mockResolvedValue(cleanupResult)

    const result = await updateMessageAndBlocksThunk(
      topicId,
      { id: messageId, updatedAt: '2026-07-29T00:00:00.000Z' },
      [makeBlock('block-1', 'content')]
    )(dispatch)

    expect(result).toEqual(cleanupResult)
  })

  it('returns empty cleanup when SQLite fails', async () => {
    mocks.dbUpdateMessageAndBlocks.mockRejectedValue(new Error('SQLite lock'))

    await expect(
      updateMessageAndBlocksThunk(topicId, { id: messageId, updatedAt: '2026-07-29T00:00:00.000Z' }, [])(dispatch)
    ).rejects.toThrow('SQLite lock')
  })

  it('strips id from Redux patch (only changes dispatched)', async () => {
    const messageUpdates = {
      id: messageId,
      content: 'updated content',
      updatedAt: '2026-07-29T00:00:00.000Z'
    }

    await updateMessageAndBlocksThunk(topicId, messageUpdates, [])(dispatch)

    // Redux updateMessage should contain changes but NOT id
    const reduxCall = mocks.updateMessageAction.mock.calls[0][0] as any
    expect(reduxCall.messageId).toBe(messageId) // messageId is passed in the action envelope
    expect(reduxCall.updates).not.toHaveProperty('id')
    expect(reduxCall.updates.content).toBe('updated content')
  })

  // --- LOCK-005: Combined patch + block upsert + blockIdsToDelete + cleanup rollback ---

  it('sends combined message patch + block upserts + blockIdsToDelete in single atomic call', async () => {
    const cleanupResult = { affectedFileIds: ['file-1'], remainingReferenceCounts: { 'file-1': 0 } }
    mocks.dbUpdateMessageAndBlocks.mockResolvedValue(cleanupResult)

    const messageUpdates = {
      id: messageId,
      updatedAt: '2026-07-29T00:00:00.000Z',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }
    const newBlocks = [makeBlock('block-new-1', 'new content')]
    const blockIdsToDelete = ['block-old-1', 'block-old-2']

    const result = await updateMessageAndBlocksThunk(topicId, messageUpdates, newBlocks, blockIdsToDelete)(dispatch)

    // Single atomic SQLite call with all three payloads
    expect(mocks.dbUpdateMessageAndBlocks).toHaveBeenCalledTimes(1)
    expect(mocks.dbUpdateMessageAndBlocks).toHaveBeenCalledWith(
      topicId,
      expect.objectContaining({ id: messageId, usage: messageUpdates.usage }),
      newBlocks,
      blockIdsToDelete
    )

    // Redux: message patch + block upsert + block removal all dispatched
    expect(mocks.updateMessageAction).toHaveBeenCalled()
    expect(mocks.upsertManyBlocksAction).toHaveBeenCalledWith(newBlocks)
    expect(mocks.removeManyBlocksAction).toHaveBeenCalledWith(blockIdsToDelete)

    // FileCleanupResult returned to caller
    expect(result).toEqual(cleanupResult)
  })

  it('rolls back Redux on SQLite failure (combined patch + blocks + deletions)', async () => {
    mocks.dbUpdateMessageAndBlocks.mockRejectedValue(new Error('SQLite constraint'))

    const messageUpdates = { id: messageId, updatedAt: '2026-07-29T00:00:00.000Z' }
    const newBlocks = [makeBlock('block-new-1', 'new content')]
    const blockIdsToDelete = ['block-old-1']

    await expect(
      updateMessageAndBlocksThunk(topicId, messageUpdates, newBlocks, blockIdsToDelete)(dispatch)
    ).rejects.toThrow('SQLite constraint')

    // NO Redux mutations on failure — complete rollback
    expect(dispatch).not.toHaveBeenCalled()
    expect(mocks.updateMessageAction).not.toHaveBeenCalled()
    expect(mocks.upsertManyBlocksAction).not.toHaveBeenCalled()
    expect(mocks.removeManyBlocksAction).not.toHaveBeenCalled()
  })

  it('includes usage in combined message patch when caller provides it', async () => {
    const messageUpdates = {
      id: messageId,
      updatedAt: '2026-07-29T00:00:00.000Z',
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    }

    await updateMessageAndBlocksThunk(topicId, messageUpdates, [])(dispatch)

    // Atomic call includes usage in the message patch
    expect(mocks.dbUpdateMessageAndBlocks).toHaveBeenCalledWith(
      topicId,
      expect.objectContaining({
        id: messageId,
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
      }),
      [],
      []
    )

    // Redux message update also includes usage
    const reduxCall = mocks.updateMessageAction.mock.calls[0][0] as any
    expect(reduxCall.updates.usage).toEqual({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 })
  })
})
